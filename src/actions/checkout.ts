'use server'

import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { products, cards, orders, loginUsers } from "@/lib/db/schema"
import { cancelExpiredOrders } from "@/lib/db/queries"
import { generateOrderId, generateSign } from "@/lib/crypto"
import { eq, sql, and, or } from "drizzle-orm"
import { cookies } from "next/headers"

export async function createOrder(productId: string, email?: string, usePoints: boolean = false) {
    const session = await auth()
    const user = session?.user

    // 1. Get Product
    const product = await db.query.products.findFirst({
        where: eq(products.id, productId)
    })
    if (!product) return { success: false, error: 'buy.productNotFound' }

    try {
        await cancelExpiredOrders({ productId })
    } catch {
        // Best effort cleanup
    }

    // Points Calculation
    let pointsToUse = 0
    let finalAmount = Number(product.price)

    if (usePoints && user?.id) {
        const userRec = await db.query.loginUsers.findFirst({
            where: eq(loginUsers.userId, user.id),
            columns: { points: true }
        })
        const currentPoints = userRec?.points || 0

        if (currentPoints > 0) {
            // Logic: 1 Point = 1 Unit of currency
            pointsToUse = Math.min(currentPoints, Math.ceil(finalAmount))
            finalAmount = Math.max(0, finalAmount - pointsToUse)
        }
    }

    const isZeroPrice = finalAmount <= 0

    const ensureCardsReservationColumns = async () => {
        await db.execute(sql`
            ALTER TABLE cards ADD COLUMN IF NOT EXISTS reserved_order_id TEXT;
            ALTER TABLE cards ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMP;
        `);
    }

    const ensureCardsIsUsedDefaults = async () => {
        await db.execute(sql`
            ALTER TABLE cards ALTER COLUMN is_used SET DEFAULT FALSE;
            UPDATE cards SET is_used = FALSE WHERE is_used IS NULL;
        `);
    }

    const getAvailableStock = async () => {
        const result = await db.select({ count: sql<number>`count(*)::int` })
            .from(cards)
            .where(sql`
                ${cards.productId} = ${productId}
                AND (COALESCE(${cards.isUsed}, false) = false)
                AND (${cards.reservedAt} IS NULL OR ${cards.reservedAt} < NOW() - INTERVAL '1 minute')
            `)
        return result[0]?.count || 0
    }

    // 2. Check Stock
    let stock = 0
    try {
        stock = await getAvailableStock()
    } catch (error: any) {
        const errorString = JSON.stringify(error)
        const isMissingColumn =
            error?.message?.includes('reserved_order_id') ||
            error?.message?.includes('reserved_at') ||
            errorString.includes('42703')

        if (isMissingColumn) {
            await ensureCardsReservationColumns()
            stock = await getAvailableStock()
        } else {
            throw error
        }
    }

    if (stock <= 0) {
        try {
            const nullUsed = await db.select({ count: sql<number>`count(*)::int` })
                .from(cards)
                .where(sql`${cards.productId} = ${productId} AND ${cards.isUsed} IS NULL`)
            if ((nullUsed[0]?.count || 0) > 0) {
                await ensureCardsIsUsedDefaults()
                stock = await getAvailableStock()
            }
        } catch {
            // ignore
        }
    }

    if (stock <= 0) return { success: false, error: 'buy.outOfStock' }

    // 3. Check Purchase Limit
    if (product.purchaseLimit && product.purchaseLimit > 0) {
        const currentUserId = user?.id
        const currentUserEmail = email || user?.email

        if (currentUserId || currentUserEmail) {
            const conditions = [eq(orders.productId, productId)]
            const userConditions = []

            if (currentUserId) userConditions.push(eq(orders.userId, currentUserId))
            if (currentUserEmail) userConditions.push(eq(orders.email, currentUserEmail))

            if (userConditions.length > 0) {
                // For zero price instant delivery, we must count 'delivered' too (already covered)
                const countResult = await db.select({ count: sql<number>`count(*)::int` })
                    .from(orders)
                    .where(and(
                        eq(orders.productId, productId),
                        or(...userConditions),
                        or(eq(orders.status, 'paid'), eq(orders.status, 'delivered'))
                    ))

                const existingCount = countResult[0]?.count || 0
                if (existingCount >= product.purchaseLimit) {
                    return { success: false, error: 'buy.limitExceeded' }
                }
            }
        }
    }

    // 4. Create Order + Reserve Stock (1 minute) OR Deliver Immediately
    const orderId = generateOrderId()

    const reserveAndCreate = async () => {
        await db.transaction(async (tx) => {
            // Verify and Deduct Points inside transaction
            if (pointsToUse > 0) {
                const updatedUser = await tx.update(loginUsers)
                    .set({ points: sql`${loginUsers.points} - ${pointsToUse}` })
                    .where(and(eq(loginUsers.userId, user!.id!), sql`${loginUsers.points} >= ${pointsToUse}`))
                    .returning({ points: loginUsers.points });

                if (!updatedUser.length) {
                    throw new Error('insufficient_points');
                }
            }

            const reservedResult = await tx.execute(sql`
                UPDATE cards
                SET reserved_order_id = ${orderId}, reserved_at = NOW()
                WHERE id = (
                    SELECT id
                    FROM cards
                    WHERE product_id = ${productId}
                      AND COALESCE(is_used, false) = false
                      AND (reserved_at IS NULL OR reserved_at < NOW() - INTERVAL '1 minute')
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED
                )
                RETURNING id, card_key
            `);

            if (!reservedResult.rows.length) {
                throw new Error('stock_locked');
            }

            const cardKey = reservedResult.rows[0].card_key as string;
            const cardId = reservedResult.rows[0].id as number;

            // If Zero Price: Mark card used and order delivered immediately
            if (isZeroPrice) {
                await tx.update(cards).set({
                    isUsed: true,
                    usedAt: new Date(),
                    reservedOrderId: null,
                    reservedAt: null
                }).where(eq(cards.id, cardId));

                await tx.insert(orders).values({
                    orderId,
                    productId: product.id,
                    productName: product.name,
                    amount: finalAmount.toString(), // 0.00
                    email: email || user?.email || null,
                    userId: user?.id || null,
                    username: user?.username || null,
                    status: 'delivered',
                    cardKey: cardKey,
                    paidAt: new Date(),
                    deliveredAt: new Date(),
                    tradeNo: 'POINTS_REDEMPTION',
                    pointsUsed: pointsToUse
                });

            } else {
                // Normal Pending Order
                await tx.insert(orders).values({
                    orderId,
                    productId: product.id,
                    productName: product.name,
                    amount: finalAmount.toString(),
                    email: email || user?.email || null,
                    userId: user?.id || null,
                    username: user?.username || null,
                    status: 'pending',
                    pointsUsed: pointsToUse
                });
            }
        });
    };

    try {
        await reserveAndCreate();
    } catch (error: any) {
        if (error?.message === 'stock_locked') {
            return { success: false, error: 'buy.stockLocked' };
        }
        if (error?.message === 'insufficient_points') {
            return { success: false, error: 'Points mismatch, please try again.' };
        }

        // Schema retry logic 
        const errorString = JSON.stringify(error);
        const isMissingColumn =
            error?.message?.includes('reserved_order_id') ||
            error?.message?.includes('reserved_at') ||
            errorString.includes('42703');

        if (isMissingColumn) {
            await db.execute(sql`
                ALTER TABLE cards ADD COLUMN IF NOT EXISTS reserved_order_id TEXT;
                ALTER TABLE cards ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMP;
            `);

            try {
                await reserveAndCreate();
            } catch (retryError: any) {
                if (retryError?.message === 'stock_locked') return { success: false, error: 'buy.stockLocked' };
                if (retryError?.message === 'insufficient_points') return { success: false, error: 'Points mismatch' };
                throw retryError;
            }
        } else {
            throw error;
        }
    }

    // If Zero Price, return Success (redirect to order view)
    if (isZeroPrice) {
        return {
            success: true,
            url: `${process.env.NEXT_PUBLIC_APP_URL || ''}/order/${orderId}`,
            isZeroPrice: true
        }
    }

    // Set Pending Cookie
    const cookieStore = await cookies()
    cookieStore.set('ldc_pending_order', orderId, { secure: true, path: '/', sameSite: 'lax' })

    // 4. Generate Pay Params
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
    const payParams: Record<string, any> = {
        pid: process.env.MERCHANT_ID!,
        type: 'epay',
        out_trade_no: orderId,
        notify_url: `${baseUrl}/api/notify`,
        return_url: `${baseUrl}/callback/${orderId}`,
        name: product.name,
        money: Number(finalAmount).toFixed(2),
        sign_type: 'MD5'
    }

    payParams.sign = generateSign(payParams, process.env.MERCHANT_KEY!)

    return {
        success: true,
        url: process.env.PAY_URL || 'https://credit.linux.do/epay/pay/submit.php',
        params: payParams
    }
}

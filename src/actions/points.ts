'use server'

import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { dailyCheckins, loginUsers } from "@/lib/db/schema"
import { getSetting } from "@/lib/db/queries"
import { eq, sql } from "drizzle-orm"
import { revalidatePath } from "next/cache"

export async function checkIn() {
    const session = await auth()
    if (!session?.user?.id) {
        return { success: false, error: "Not logged in" }
    }

    const userId = session.user.id

    try {
        // 1. Check if already checked in today
        const existing = await db.execute(sql`
            SELECT id FROM daily_checkins 
            WHERE user_id = ${userId} 
            AND date(created_at) = date(now())
        `)

        if (existing.rowCount && existing.rowCount > 0) {
            return { success: false, error: "Already checked in today" }
        }

        // 2. Get Reward Amount
        const rewardStr = await getSetting('checkin_reward')
        const reward = parseInt(rewardStr || '10', 10)

        // 3. Perform Check-in & Award Points
        await db.transaction(async (tx) => {
            await tx.insert(dailyCheckins).values({ userId })
            await tx.update(loginUsers)
                .set({ points: sql`${loginUsers.points} + ${reward}` })
                .where(eq(loginUsers.userId, userId))
        })

        revalidatePath('/')
        return { success: true, points: reward }
    } catch (error: any) {
        // Handle "Missing Table" error for daily_checkins (Auto-migration)
        if (error.message?.includes('does not exist') || error.code === '42P01') {
            await db.execute(sql`
                CREATE TABLE IF NOT EXISTS daily_checkins (
                    id SERIAL PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT NOW()
                );
                CREATE UNIQUE INDEX IF NOT EXISTS daily_checkins_user_date_unique ON daily_checkins(user_id, date(created_at));
                ALTER TABLE login_users ADD COLUMN IF NOT EXISTS points INTEGER DEFAULT 0 NOT NULL;
            `)
            // Retry once
            return checkIn()
        }
        console.error("Check-in error:", error)
        return { success: false, error: "Check-in failed" }
    }
}

export async function getUserPoints() {
    const session = await auth()
    if (!session?.user?.id) return 0

    const user = await db.query.loginUsers.findFirst({
        where: eq(loginUsers.userId, session.user.id),
        columns: { points: true }
    })

    return user?.points || 0
}

export async function getCheckinStatus() {
    const session = await auth()
    if (!session?.user?.id) return { checkedIn: false }

    const existing = await db.execute(sql`
        SELECT id FROM daily_checkins 
        WHERE user_id = ${session.user.id} 
        AND date(created_at) = date(now())
    `)

    return { checkedIn: existing.rowCount ? existing.rowCount > 0 : false }
}

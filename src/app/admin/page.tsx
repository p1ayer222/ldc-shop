import { db } from "@/lib/db"
import { orders } from "@/lib/db/schema"
import { desc } from "drizzle-orm"
import { getProducts, getDashboardStats, getSetting, getVisitorCount } from "@/lib/db/queries"
import { AdminProductsContent } from "@/components/admin/products-content"

export default async function AdminPage() {
    const [products, stats, shopName, visitorCount, lowStockThreshold, recentOrders, checkinReward] = await Promise.all([
        getProducts(),
        getDashboardStats(),
        (async () => {
            try {
                return await getSetting('shop_name')
            } catch {
                return null
            }
        })(),
        (async () => {
            try {
                return await getVisitorCount()
            } catch {
                return 0
            }
        })(),
        (async () => {
            try {
                const v = await getSetting('low_stock_threshold')
                return Number.parseInt(v || '5', 10) || 5
            } catch {
                return 5
            }
        })(),
        (async () => {
            try {
                return await db.query.orders.findMany({ orderBy: [desc(orders.createdAt)], limit: 10 })
            } catch {
                return []
            }
        })(),

        (async () => {
            try {
                const v = await getSetting('checkin_reward')
                return Number.parseInt(v || '10', 10) || 10
            } catch {
                return 10
            }
        })(),
    ])

    return (
        <AdminProductsContent
            products={products.map(p => ({
                id: p.id,
                name: p.name,
                price: p.price,
                compareAtPrice: p.compareAtPrice ?? null,
                category: p.category,
                stockCount: p.stock,
                isActive: p.isActive ?? true,
                isHot: p.isHot ?? false,
                sortOrder: p.sortOrder ?? 0
            }))}
            stats={stats}
            shopName={shopName}
            visitorCount={visitorCount}
            lowStockThreshold={lowStockThreshold}
            recentOrders={recentOrders.map(o => ({
                orderId: o.orderId,
                productName: o.productName,
                amount: o.amount,
                status: o.status || 'pending',
                createdAt: o.createdAt
            }))}
            checkinReward={checkinReward}
        />
    )
}

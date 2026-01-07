'use client'

import { useState, useEffect } from "react"
import { createOrder } from "@/actions/checkout"
import { getUserPoints } from "@/actions/points"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Loader2, Coins } from "lucide-react"
import { toast } from "sonner"
import { useI18n } from "@/lib/i18n/context"

interface BuyButtonProps {
    productId: string
    price: string | number
    productName: string
    disabled?: boolean
}

export function BuyButton({ productId, price, productName, disabled }: BuyButtonProps) {
    const [loading, setLoading] = useState(false)
    const [open, setOpen] = useState(false)
    const [points, setPoints] = useState(0)
    const [usePoints, setUsePoints] = useState(false)
    const [pointsLoading, setPointsLoading] = useState(false)
    const { t } = useI18n()

    const numericalPrice = Number(price)

    const handleInitialClick = async () => {
        if (disabled) return
        setOpen(true)
        setPointsLoading(true)
        try {
            const p = await getUserPoints()
            setPoints(p)
            // Auto-check if points cover full price? Maybe not. Let user decide.
        } catch (e) {
            console.error(e)
        } finally {
            setPointsLoading(false)
        }
    }

    const handleBuy = async () => {
        try {
            setLoading(true)
            const result = await createOrder(productId, undefined, usePoints)

            if (!result?.success) {
                const message = result?.error ? t(result.error) : t('common.error')
                toast.error(message)
                setLoading(false)
                return
            }

            if (result.isZeroPrice && result.url) {
                toast.success("Payment successful using points!")
                window.location.href = result.url
                return
            }

            const { url, params } = result

            if (!params || !url) {
                toast.error(t('common.error'))
                setLoading(false)
                return
            }

            if (params) {
                // Submit Form
                const form = document.createElement('form')
                form.method = 'POST'
                form.action = url as string

                Object.entries(params as Record<string, any>).forEach(([k, v]) => {
                    const input = document.createElement('input')
                    input.type = 'hidden'
                    input.name = k
                    input.value = String(v)
                    form.appendChild(input)
                })

                document.body.appendChild(form)
                form.submit()
            }

        } catch (e: any) {
            toast.error(e.message || "Failed to create order")
            setLoading(false)
        }
    }

    // Calculation for UI
    const pointsToUse = usePoints ? Math.min(points, Math.ceil(numericalPrice)) : 0
    const finalPrice = Math.max(0, numericalPrice - pointsToUse)

    return (
        <>
            <Button
                size="lg"
                className="w-full md:w-auto bg-foreground text-background hover:bg-foreground/90"
                onClick={handleInitialClick}
                disabled={disabled}
            >
                {t('common.buyNow')}
            </Button>

            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t('common.buyNow')}</DialogTitle>
                        <DialogDescription>{productName}</DialogDescription>
                    </DialogHeader>

                    <div className="grid gap-4 py-4">
                        <div className="flex justify-between items-center">
                            <span className="font-medium">Price</span>
                            <span>{numericalPrice.toFixed(2)}</span>
                        </div>

                        {points > 0 && (
                            <div className="flex items-center space-x-2 border p-3 rounded-md">
                                <input
                                    type="checkbox"
                                    id="use-points"
                                    checked={usePoints}
                                    onChange={(e) => setUsePoints(e.target.checked)}
                                    className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                                />
                                <Label htmlFor="use-points" className="flex-1 flex justify-between cursor-pointer">
                                    <span className="flex items-center gap-1">
                                        Use Points <Coins className="w-3 h-3 text-yellow-500" />
                                    </span>
                                    <span className="text-muted-foreground">
                                        -{pointsToUse} (Avail: {points})
                                    </span>
                                </Label>
                            </div>
                        )}

                        <div className="flex justify-between items-center border-t pt-4 font-bold text-lg">
                            <span>Total</span>
                            <span>{finalPrice.toFixed(2)}</span>
                        </div>
                    </div>

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>
                            Cancel
                        </Button>
                        <Button onClick={handleBuy} disabled={loading}>
                            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            {finalPrice === 0 ? "Pay with Points" : "Proceed to Payment"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    )
}

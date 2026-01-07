'use client'

import { useState, useEffect } from 'react'
import { Button } from "@/components/ui/button"
import { checkIn, getUserPoints, getCheckinStatus } from "@/actions/points"
import { toast } from "sonner"
import { Gift, Coins } from "lucide-react"
import { cn } from "@/lib/utils"

export function CheckInButton() {
    const [points, setPoints] = useState(0)
    const [checkedIn, setCheckedIn] = useState(false)
    const [loading, setLoading] = useState(true)
    const [checkingIn, setCheckingIn] = useState(false)

    useEffect(() => {
        const init = async () => {
            try {
                const [p, s] = await Promise.all([getUserPoints(), getCheckinStatus()])
                setPoints(p)
                setCheckedIn(s.checkedIn)
            } catch (e) {
                console.error(e)
            } finally {
                setLoading(false)
            }
        }
        init()
    }, [])

    const handleCheckIn = async () => {
        setCheckingIn(true)
        try {
            const res = await checkIn()
            if (res.success) {
                toast.success(`Check-in successful! +${res.points} points`)
                setPoints(prev => prev + (res.points || 0))
                setCheckedIn(true)
            } else {
                if (res.error === "Already checked in today") {
                    setCheckedIn(true)
                }
                toast.error(res.error || "Check-in failed")
            }
        } catch (e) {
            toast.error("Network error")
        } finally {
            setCheckingIn(false)
        }
    }

    if (loading) return null

    return (
        <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-muted/50 rounded-full text-sm font-medium">
                <Coins className="w-4 h-4 text-yellow-500" />
                <span>{points}</span>
            </div>

            {!checkedIn && (
                <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-2 bg-gradient-to-r from-amber-500/10 to-orange-500/10 hover:from-amber-500/20 hover:to-orange-500/20 border-amber-500/20 text-amber-600 dark:text-amber-400"
                    onClick={handleCheckIn}
                    disabled={checkingIn}
                >
                    <Gift className={cn("w-4 h-4", checkingIn && "animate-pulse")} />
                    Check In
                </Button>
            )}
        </div>
    )
}

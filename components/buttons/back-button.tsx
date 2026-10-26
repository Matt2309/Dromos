"use client";

import {ArrowLeftIcon} from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface BackButtonProps {
    className?: string;
}

export function BackButton({
                               className,
                           }: BackButtonProps) {
    const router = useRouter();

    const handleBack = () => {
        const referrer = document.referrer;
        const currentOrigin = window.location.origin;

        // A tab opened via target="_blank" (every legal link shown to a
        // logged-out user) has a same-origin referrer but no history entry to
        // go back to, so router.back() would be a no-op.
        const hasHistory = window.history.length > 1;

        if (hasHistory && referrer.startsWith(currentOrigin)) {
            router.back();
        } else {
            router.push("/");
        }
    };

    return (
        <div className="flex items-center">
            <Button
                variant="ghost"
                size="icon"
                onClick={handleBack}
                className={cn("text-inherit", className)}
            >
                <ArrowLeftIcon className="w-6 h-6" />
            </Button>
        </div>
    );
}
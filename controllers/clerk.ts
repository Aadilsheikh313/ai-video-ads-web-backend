import { verifyWebhook } from "@clerk/express/webhooks";
import type { Request, Response } from "express";
import { prisma } from "../configs/prisma.js";
import * as Sentry from "@sentry/node";

type ClerkUserData = {
    id: string;
    email_addresses?: Array<{
        email_address?: string;
    }>;
    first_name?: string | null;
    last_name?: string | null;
    image_url?: string | null;
};

const clerkWebhooks = async (req: Request, res: Response) => {
    // 1. Verify webhook signature
    let evt: any;
    try {
        evt = await verifyWebhook(req);
    } catch (error: any) {
        console.error("CLERK WEBHOOK VERIFICATION FAILED");
        console.error("Error:", error?.message);
        Sentry.captureException(error);

        return res.status(400).json({
            message: "Invalid webhook signature",
        });
    }

    const { data, type } = evt;
    try {
        switch (type) {
            // ==========================================
            // USER CREATED
            // ==========================================
            case "user.created": {
                const userData = data as ClerkUserData;

                if (!userData?.id) {
                    return res.status(400).json({
                        message: "Missing Clerk user ID",
                    });
                }

                const email =
                    userData.email_addresses?.find(
                        (item) => item.email_address
                    )?.email_address ?? "";

                const name =
                    `${userData.first_name ?? ""} ${userData.last_name ?? ""}`.trim();

                const image = userData.image_url ?? "";

                const user = await prisma.user.upsert({
                    where: {
                        id: userData.id,
                    },
                    update: {
                        email,
                        name,
                        image,
                    },
                    create: {
                        id: userData.id,
                        email,
                        name,
                        image,
                        credits: 20,
                    },
                });

                break;
            }

            // ==========================================
            // USER UPDATED
            // ==========================================
            case "user.updated": {
                const userData = data as ClerkUserData;

                if (!userData?.id) {
                    return res.status(400).json({
                        message: "Missing Clerk user ID",
                    });
                }

                const email =
                    userData.email_addresses?.find(
                        (item) => item.email_address
                    )?.email_address ?? "";

                const name =
                    `${userData.first_name ?? ""} ${userData.last_name ?? ""}`.trim();

                const image = userData.image_url ?? "";

                const user = await prisma.user.upsert({
                    where: {
                        id: userData.id,
                    },
                    update: {
                        email,
                        name,
                        image,
                    },
                    create: {
                        id: userData.id,
                        email,
                        name,
                        image,
                        credits: 20,
                    },
                });
                break;
            }

            // ==========================================
            // USER DELETED
            // ==========================================
            case "user.deleted": {
                const userData = data as ClerkUserData;

                if (!userData?.id) {
                    return res.status(400).json({
                        message: "Missing Clerk user ID",
                    });
                }

                const result = await prisma.user.deleteMany({
                    where: {
                        id: userData.id,
                    },
                });
                break;
            }

            // ==========================================
            // PAYMENT CREATED (Pending State)
            // ==========================================
            case "payment_attempt.created":
            case "paymentAttempt.created": {
                console.log("PAYMENT ATTEMPT CREATED (PENDING):", {
                    paymentId: data?.id,
                    status: data?.status,
                    chargeType: data?.charge_type,
                    userId: data?.payer?.user_id,
                });
                // Is stage par payment pending hoti hai, isliye credits update nahi honge
                break;
            }

            // ==========================================
            // PAYMENT UPDATED (Success / Paid State)
            // ==========================================
            case "payment_attempt.updated":
            case "paymentAttempt.updated": {
                console.log("PAYMENT ATTEMPT UPDATED RECEIVED:", {
                    paymentId: data?.id,
                    status: data?.status,
                    chargeType: data?.charge_type,
                });

                if (
                    (data?.charge_type === "recurring" ||
                        data?.charge_type === "checkout") &&
                    data?.status === "paid"
                ) {
                    const clerkUserId = data?.payer?.user_id;

                    if (!clerkUserId) {
                        console.error("Payment event has no Clerk user ID");
                        return res.status(400).json({
                            message: "Missing payment user ID",
                        });
                    }

                    const existingUser = await prisma.user.findUnique({
                        where: { id: clerkUserId },
                    });

                    if (!existingUser) {
                        console.error("PAYMENT USER NOT FOUND IN DB:", clerkUserId);
                        return res.status(404).json({
                            success: false,
                            message: "Payment user not found in database",
                        });
                    }

                    const rawPlanSlug =
                        data?.subscription_items?.[0]?.plan?.slug ?? "";
                    const planSlug = rawPlanSlug.toLowerCase();

                    const creditsMap: Record<string, number> = {
                        pro: 80,
                        premium: 240,
                    };

                    let creditsToAdd = 0;
                    if (planSlug.includes("premium")) {
                        creditsToAdd = creditsMap.premium;
                    } else if (planSlug.includes("pro")) {
                        creditsToAdd = creditsMap.pro;
                    }

                    if (creditsToAdd === 0) {
                        console.error("Unknown payment plan slug:", rawPlanSlug);
                        return res.status(400).json({
                            message: "Invalid plan slug",
                        });
                    }

                    const updatedUser = await prisma.user.update({
                        where: {
                            id: clerkUserId,
                        },
                        data: {
                            credits: {
                                increment: creditsToAdd,
                            },
                        },
                    });

                    console.log("PAYMENT CREDITS UPDATED SUCCESSFULLY:", {
                        userId: updatedUser.id,
                        added: creditsToAdd,
                        totalCredits: updatedUser.credits,
                    });
                } else {
                    console.log("PAYMENT UPDATED BUT NOT ELIGIBLE FOR CREDITS:", {
                        status: data?.status,
                        chargeType: data?.charge_type,
                    });
                }

                break;
            }

            default: {
                console.log("Unhandled Clerk event:", type);
                break;
            }
        }

        return res.status(200).json({
            success: true,
            message: "Webhook processed successfully",
            type,
        });
    } catch (error: any) {
        console.error("CLERK WEBHOOK PROCESSING FAILED");
        console.error("Event:", type);
        console.error("Error message:", error?.message);

        Sentry.captureException(error);

        return res.status(500).json({
            success: false,
            message: "Webhook processing failed",
        });
    }
};

export default clerkWebhooks;
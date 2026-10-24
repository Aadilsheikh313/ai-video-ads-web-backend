import {
    Request,
    Response,
    NextFunction
} from "express";

import * as Sentry from "@sentry/node";


export const protect = (
    req: Request,
    res: Response,
    next: NextFunction
) => {

    try {

        const { userId } = req.auth();

        if (!userId) {
            return res.status(401).json({
                message: "Unauthorized",
            });
        }

        next();

    } catch (error: any) {

        console.error(
            "AUTH ERROR:",
            error
        );

        Sentry.captureException(error);

        return res.status(401).json({
            message:
                error?.message ||
                "Authentication failed",
        });
    }
};
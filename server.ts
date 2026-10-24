import "./configs/instrument.mjs";

import express, { Request, Response} from "express";
import cors from "cors";
import "dotenv/config";
import { clerkMiddleware} from "@clerk/express";
import clerkWebhooks from "./controllers/clerk.js";
import * as Sentry from "@sentry/node";
import userRouter from "./routes/useRoutes.js";
import projectRouter from "./routes/projectRouter.js";


const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());

// =========CLERK WEBHOOK  IMPORTANT: MUST COME BEFORE express.json()=============
app.post(
    "/api/clerk",
    express.raw({
        type: "application/json"
    }),
    clerkWebhooks
);

// ==========================================
// JSON
// ==========================================

app.use(express.json());


// ==========================================
// CLERK AUTH MIDDLEWARE
// ==========================================

app.use(clerkMiddleware());


// ==========================================
// HEALTH / ROOT
// ==========================================

app.get(
    "/",
    (req: Request, res: Response) => {
        res.send("Server is Live");
    }
);


// ==========================================
// SENTRY TEST
// ==========================================

app.get(
    "/debug-sentry",
    function mainHandler(req, res) {

        Sentry.logger.info(
            "User triggered test error",
            {
                action: "test_error_endpoint",
            }
        );

        Sentry.metrics.count(
            "test_counter",
            1
        );

        throw new Error(
            "My first Sentry error!"
        );
    }
);


// ==========================================
// USER ROUTES
// ==========================================

app.use(
    "/api/user",
    userRouter
);


// ==========================================
// PROJECT ROUTES
// ==========================================

app.use(
    "/api/project",
    projectRouter
);


// ==========================================
// SENTRY ERROR HANDLER
// ==========================================

Sentry.setupExpressErrorHandler(app);


// ==========================================
// START SERVER
// ==========================================

app.listen(
    PORT,
    () => {
        console.log(
            `Server is running: http://localhost:${PORT}`
        );
    }
);
import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";

Sentry.init({
    dsn: "https://1f1e752c175be3d4612c6f7d2c986345@o4512111442722816.ingest.de.sentry.io/4512111486828624",
    integrations: [
        nodeProfilingIntegration(),
    ],
    // Tracing
    tracesSampleRate: 1.0, // Capture 100% of transactions
    // Set sampling rate for profiling
    profileSessionSampleRate: 1.0,
    // Trace lifecycle automatically enables profiling during active traces
    profileLifecycle: "trace",
    dataCollection: {
        // userInfo: false,
        // httpBodies: [],
    },
});

// Profiling span
Sentry.startSpan(
    {
        name: "My Span",
    },
    () => {
        // The code executed here will be profiled
    }
);
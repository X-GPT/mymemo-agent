import { Hono } from "hono";
import { artifactRoutes } from "../features/artifacts";
import { conversationHistoryRoutes } from "../features/conversation-history";
import { conversationsRoutes } from "../features/conversations";

const app = new Hono();

/* ---------- feature routers ---------- */
app.route("/conversations", conversationsRoutes);
app.route("/conversations", conversationHistoryRoutes);
app.route("/conversations", artifactRoutes);

export default app;

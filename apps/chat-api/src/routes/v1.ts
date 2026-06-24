import { Hono } from "hono";
import { conversationsRoutes } from "../features/conversations";

const app = new Hono();

/* ---------- feature routers ---------- */
app.route("/conversations", conversationsRoutes);

export default app;

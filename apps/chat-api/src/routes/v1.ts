import { Hono } from "hono";
import { artifactRoutes } from "../features/artifacts";
import { conversationsRoutes } from "../features/conversations";

const app = new Hono();

/* ---------- feature routers ---------- */
app.route("/conversations", conversationsRoutes);
app.route("/conversations", artifactRoutes);

export default app;

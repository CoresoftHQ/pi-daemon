import { Type } from "typebox";
export default function (pi) { pi.registerTool({ name: "noop", label: "Noop", description: "noop", parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; } }); }

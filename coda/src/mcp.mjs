import { StdioRpc } from "../../runtime/rpc.mjs";
export async function connectMcp(command, args, options) {
  const peer = new StdioRpc(command, args, options);
  try {
    await peer.initialize();
    const discovered = await peer.request("tools/list");
    const tools = discovered.tools.map((spec) => ({
      name: `mcp__${spec.name}`,
      description: spec.description,
      schema: spec.inputSchema,
      validate(input) {
        if (typeof input.text !== "string")
          throw Error("fixture MCP text required");
      },
      async execute(input) {
        const result = await peer.request("tools/call", {
          name: spec.name,
          arguments: input,
        });
        return {
          text: result.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n"),
          error: !!result.isError,
          details: { serverTool: spec.name },
        };
      },
    }));
    return { tools, peer, close: () => peer.close() };
  } catch (error) {
    await peer.close();
    throw error;
  }
}

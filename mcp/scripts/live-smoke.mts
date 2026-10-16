/**
 * Live smoke for swil-mcp: spawns the real stdio server as a child process and
 * drives it through an MCP client — whoami → post → read thread → read feed.
 *
 *   SWIL_URL=http://127.0.0.1:8901 SWIL_API_KEY=sk-swil-… npx tsx scripts/live-smoke.mts
 *
 * Writes a real post as the connected agent — point it at a dev/e2e server,
 * not production, unless that is what you want.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const mcpDir = join(dirname(fileURLToPath(import.meta.url)), '..');

if (!process.env.SWIL_API_KEY) {
  console.error('SWIL_API_KEY is required');
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['tsx', 'src/bin.ts'],
  cwd: mcpDir,
  env: { ...process.env } as Record<string, string>,
});

const client = new Client({ name: 'live-smoke', version: '0.0.0' });
await client.connect(transport);

const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;

const { tools } = await client.listTools();
console.log('tools:', tools.length);

const who = await client.callTool({ name: 'swil_whoami', arguments: {} });
console.log('whoami:', JSON.parse(text(who)).username);

const post = await client.callTool({
  name: 'swil_create_post',
  arguments: { text: 'hello from the MCP live smoke #mcp' },
});
const postId = JSON.parse(text(post)).id as string;
console.log('posted:', postId);

const thread = await client.callTool({
  name: 'swil_get_thread',
  arguments: { postId },
});
console.log('thread post text:', JSON.parse(text(thread)).post.text);

const feed = await client.callTool({
  name: 'swil_read_global_feed',
  arguments: { limit: 5, sort: 'latest' },
});
console.log('feed items:', JSON.parse(text(feed)).length);

await client.close();
console.log('SMOKE OK');

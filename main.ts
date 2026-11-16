import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

type Obj = Record<string, any>;
const arr = (v: any): any[] => Array.isArray(v) ? v : [];
const obj = (v: any): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const documents: Obj[] = (process.env.MAKEFUN_PROMPT_FILE ? readFileSync(process.env.MAKEFUN_PROMPT_FILE, 'utf8') : '').split(/\r?\n/).flatMap(line => {
  try { const d = JSON.parse(line); return d && typeof d.schema === 'string' ? [d] : []; } catch { return []; }
});
const providers = arr(documents.find(d => d.schema.endsWith('/providers/v1'))?.providers);
const ratings = arr(documents.find(d => d.schema.endsWith('/models/v1'))?.models).filter(m => m.free === true);
const manifest = arr(documents.find(d => d.schema.endsWith('/prompts/v1'))?.prompts);
const catalogProviders = providers.length ? providers : ratings.length ? [{ id: 'openrouter', base_url: 'https://openrouter.ai/api/v1', key_env: 'OPENROUTER_API_KEY', wire: 'openai' }] : [];
const catalog = { providers: catalogProviders.map(p => ({
  id: p.id, base_url: p.path ?? p.base_url, key_env: p.key_env, wire: p.wire,
  models: ratings.filter(m => m.provider === p.id).map(m => ({ id: m.id, free: true, context_length: m.context_length ?? null })).sort((a, b) => a.id.localeCompare(b.id)),
})) };
const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const gateway = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
const gatewayKey = process.env.OPENAI_API_KEY ?? '';
let requestIndex = 0;
const providerFailures = new Map<string, number>();
const failedModels = new Set<string>();

function listModels(): Obj[] { return ratings.map(m => ({ id: m.id, provider: m.provider, display_name: m.display_name })); }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function choose(needs: Obj): Obj[] {
  return ratings.filter(m => (!needs.json || m.json === true) && (!needs.tools || m.tools === true) && (!needs.vision || m.vision === true))
    .sort((a, b) => b.rating_milli - a.rating_milli || compare(a.id, b.id));
}
function needsFor(body: Obj): Obj {
  const declared = manifest[requestIndex++];
  if (declared) return declared.requires ?? {};
  const json = ['json_object', 'json_schema'].includes(body.response_format?.type);
  const vision = arr(body.messages).some(m => arr(m.content).some(c => c.type === 'image' || c.type === 'image_url'));
  return { json, vision, tools: arr(body.tools).length > 0 };
}
function anthropicToChat(body: Obj, model: string): Obj {
  const messages: Obj[] = [];
  const text = (v: any): string => typeof v === 'string' ? v : arr(v).filter(x => x.type === 'text').map(x => x.text ?? '').join('\n');
  if (body.system !== undefined) messages.push({ role: 'system', content: text(body.system) });
  for (const m of arr(body.messages)) {
    if (typeof m.content === 'string') { messages.push({ role: m.role, content: m.content }); continue; }
    const parts: Obj[] = [], calls: Obj[] = [];
    for (const b of arr(m.content)) {
      if (b.type === 'text') parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image') {
        const s = obj(b.source);
        if (s.type === 'base64') parts.push({ type: 'image_url', image_url: { url: `data:${s.media_type};base64,${s.data}` } });
        else if (s.url) parts.push({ type: 'image_url', image_url: { url: s.url } });
      } else if (b.type === 'tool_use') calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
      else if (b.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: text(b.content) });
    }
    if (parts.length || calls.length) messages.push({ role: m.role, content: parts.length ? parts : null, ...(calls.length ? { tool_calls: calls } : {}) });
  }
  const out: Obj = { ...body, model, messages, max_tokens: body.max_tokens };
  delete out.system; delete out.stop_sequences;
  if (body.stop_sequences) out.stop = body.stop_sequences;
  if (body.tools) out.tools = body.tools.map((t: Obj) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  if (body.tool_choice) out.tool_choice = body.tool_choice.type === 'tool' ? { type: 'function', function: { name: body.tool_choice.name } } : body.tool_choice.type === 'any' ? 'required' : body.tool_choice.type;
  if (body.stream) out.stream_options = { include_usage: true };
  return out;
}

function send(res: any, status: number, body: any, extra: Obj = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...extra });
  res.end(text);
}
function errorBody(wire: string, message: string): Obj {
  return wire === 'anthropic' ? { type: 'error', error: { type: 'api_error', message } } : { error: { message, type: 'upstream_error', code: null } };
}
async function readBody(req: any): Promise<Obj> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new Error('request too large'); chunks.push(chunk); }
  return obj(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

type SseFrame = { event: string | null; data: string };
type StreamAnswer = { content: string; finish: string | null; usage: { input: number; output: number } | null; calls: Obj[] };

function frames(raw: string): SseFrame[] {
  const out: SseFrame[] = [];
  for (const block of raw.replace(/\r\n/g, '\n').split('\n\n')) {
    let event: string | null = null;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
    }
    if (data.length) out.push({ event, data: data.join('\n') });
  }
  return out;
}
function whole(v: any): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function usageOf(v: any): { input: number; output: number } | null {
  const u = obj(v), input = whole(u.prompt_tokens) ?? whole(u.input_tokens), output = whole(u.completion_tokens) ?? whole(u.output_tokens);
  if (input === null && output === null) return null;
  return { input: input ?? 0, output: output ?? 0 };
}
function collectTools(delta: Obj, calls: Map<number, Obj>): void {
  for (const raw of arr(delta.tool_calls)) {
    const call = obj(raw), fn = obj(call.function);
    const index = whole(call.index) ?? calls.size;
    const seen = calls.get(index) ?? { id: '', name: '', arguments: '' };
    if (typeof call.id === 'string' && call.id !== '') seen.id = call.id;
    if (typeof fn.name === 'string' && fn.name !== '') seen.name = seen.name === '' ? fn.name : seen.name;
    if (typeof fn.arguments === 'string') seen.arguments += fn.arguments;
    calls.set(index, seen);
  }
}
function normalizeStream(raw: string): StreamAnswer {
  let content = '', finish: string | null = null, usage: { input: number; output: number } | null = null;
  const calls = new Map<number, Obj>();
  for (const frame of frames(raw)) {
    const payload = frame.data.trim();
    if (payload === '' || payload === '[DONE]') continue;
    let chunk: Obj;
    try { const parsed = JSON.parse(payload); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue; chunk = parsed; } catch { continue; }
    usage = usageOf(chunk.usage) ?? usage;
    const choice = obj(arr(chunk.choices)[0]), delta = obj(choice.delta);
    if (typeof delta.content === 'string') content += delta.content;
    collectTools(delta, calls);
    if (finish === null && typeof choice.finish_reason === 'string') finish = choice.finish_reason;
  }
  return { content, finish, usage, calls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]) };
}
function normalizeJson(answer: Obj): StreamAnswer {
  const choice = obj(arr(answer.choices)[0]), message = obj(choice.message), calls = new Map<number, Obj>();
  arr(message.tool_calls).forEach((raw, index) => collectTools({ tool_calls: [{ ...obj(raw), index }] }, calls));
  const content = typeof message.content === 'string' ? message.content : arr(message.content).filter(part => obj(part).type === 'text').map(part => obj(part).text ?? '').join('');
  return { content, finish: typeof choice.finish_reason === 'string' ? choice.finish_reason : null, usage: usageOf(answer.usage), calls: [...calls.values()] };
}
function stopReasonOf(finish: string | null): string {
  if (finish === 'length') return 'max_tokens';
  if (finish === 'tool_calls' || finish === 'function_call') return 'tool_use';
  if (finish === 'content_filter') return 'refusal';
  return 'end_turn';
}
function toolInput(call: Obj): Obj {
  try { return obj(JSON.parse(call.arguments ?? '{}')); } catch { return {}; }
}
function anthropicAnswer(ans: StreamAnswer, model: string): Obj {
  const content: Obj[] = [];
  if (ans.content !== '') content.push({ type: 'text', text: ans.content });
  for (const call of ans.calls) content.push({ type: 'tool_use', id: call.id || 'toolu_router', name: call.name, input: toolInput(call) });
  if (!content.length) content.push({ type: 'text', text: '' });
  return { id: 'msg_router', type: 'message', role: 'assistant', model, content,
    stop_reason: stopReasonOf(ans.finish), stop_sequence: null,
    usage: { input_tokens: ans.usage?.input ?? 0, output_tokens: ans.usage?.output ?? 0 } };
}
function openaiEvents(ans: StreamAnswer, model: string): string {
  const out: string[] = [], stamp = 1767225600;
  const chunk = (delta: Obj, finish: string | null, usage?: Obj) => {
    const packet: Obj = { id: 'chatcmpl-router', object: 'chat.completion.chunk', created: stamp, model, choices: [{ index: 0, delta, finish_reason: finish, native_finish_reason: finish }] };
    if (usage) packet.usage = usage;
    out.push(`data: ${JSON.stringify(packet)}\n\n`);
  };
  if (ans.content !== '') chunk({ role: 'assistant', content: ans.content }, null);
  if (ans.calls.length) chunk({ role: 'assistant', content: '', tool_calls: ans.calls.map((call, index) => ({ index, id: call.id || `call_router_${index}`, type: 'function', function: { name: call.name, arguments: call.arguments || '{}' } })) }, null);
  chunk({ role: 'assistant', content: '' }, ans.finish ?? 'stop', ans.usage ? { prompt_tokens: ans.usage.input, completion_tokens: ans.usage.output, total_tokens: ans.usage.input + ans.usage.output } : undefined);
  out.push('data: [DONE]\n\n');
  return out.join('');
}
function anthroEvents(ans: StreamAnswer, model: string): string {
  const out: string[] = [], stop = stopReasonOf(ans.finish);
  const event = (name: string, data: Obj) => out.push(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  event('message_start', { type: 'message_start', message: { id: 'msg_router', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: ans.usage?.input ?? 0, output_tokens: 0 } } });
  let index = 0;
  event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
  event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: ans.content } });
  event('content_block_stop', { type: 'content_block_stop', index });
  for (const call of ans.calls) {
    index += 1;
    event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id || `toolu_router_${index}`, name: call.name, input: {} } });
    event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: call.arguments || '{}' } });
    event('content_block_stop', { type: 'content_block_stop', index });
  }
  const output = Math.max(1, ans.usage?.output ?? 0);
  event('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: output } });
  event('message_stop', { type: 'message_stop' });
  return out.join('');
}
function sendFailureTrail(res: any, wire: string, trail: Obj[], status: number): void {
  const header = trail.length ? { 'x-makefun-upstream-failures': JSON.stringify(trail.slice(0, 8)) } : {};
  send(res, status, errorBody(wire, 'No eligible upstream model completed the request'), header);
}

async function complete(req: any, res: any, wire: string): Promise<void> {
  let body: Obj;
  try { body = await readBody(req); } catch { return send(res, 400, errorBody(wire, 'Invalid JSON request body')); }
  const needs = needsFor(body), candidates = choose(needs), trail: Obj[] = [];
  const url = gateway.endsWith('/v1') ? `${gateway}/chat/completions` : `${gateway}/v1/chat/completions`;
  for (const model of candidates) {
    if (failedModels.has(model.id) || (providerFailures.get(model.provider) ?? 0) >= 2) continue;
    const payload = wire === 'anthropic' ? anthropicToChat(body, model.id) : { ...body, model: model.id, ...(body.stream ? { stream_options: { include_usage: true } } : {}) };
    let upstream: Response;
    try {
      upstream = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${gatewayKey}`, ...(body.stream ? { accept: 'text/event-stream' } : {}) }, body: JSON.stringify(payload) });
    } catch {
      const count = providerFailures.get(model.provider) ?? 0;
      providerFailures.set(model.provider, count + 1); failedModels.add(model.id);
      trail.push({ status: 502, code: 'upstream_unreachable', model: model.id }); continue;
    }
    if (!upstream.ok || !upstream.body) {
      let code = `http_${upstream.status}`;
      try { code = JSON.parse(await upstream.text()).error?.code ?? code; } catch { await upstream.body?.cancel().catch(() => {}); }
      const count = providerFailures.get(model.provider) ?? 0;
      providerFailures.set(model.provider, count + 1); failedModels.add(model.id);
      trail.push({ status: upstream.status, code, model: model.id }); continue;
    }
    const raw = await upstream.text();
    const streamed = upstream.headers.get('content-type')?.includes('text/event-stream') ?? false;
    const commonHeaders = trail.length ? { 'x-makefun-upstream-failures': JSON.stringify(trail.slice(0, 8)) } : {};
    if (!streamed && wire === 'openai' && !body.stream) { send(res, 200, { ...JSON.parse(raw), model: model.id }, commonHeaders); return; }
    const answer = streamed ? normalizeStream(raw) : normalizeJson(JSON.parse(raw));
    if (body.stream) {
      if (answer.content === '' && answer.calls.length === 0) { failedModels.add(model.id); trail.push({ status: 502, code: 'empty_stream', model: model.id }); continue; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...commonHeaders });
      res.write(wire === 'openai' ? openaiEvents(answer, model.id) : anthroEvents(answer, model.id));
      return res.end();
    }
    if (wire === 'openai') {
      const message: Obj = { role: 'assistant', content: answer.content };
      if (answer.calls.length) message.tool_calls = answer.calls.map((call, index) => ({ id: call.id || `call_router_${index}`, type: 'function', function: { name: call.name, arguments: call.arguments || '{}' } }));
      const completion: Obj = { id: 'chatcmpl-router', object: 'chat.completion', created: 1767225600, model: model.id, choices: [{ index: 0, message, finish_reason: answer.finish ?? 'stop' }] };
      if (answer.usage) completion.usage = { prompt_tokens: answer.usage.input, completion_tokens: answer.usage.output, total_tokens: answer.usage.input + answer.usage.output };
      send(res, 200, completion, commonHeaders);
    } else send(res, 200, anthropicAnswer(answer, model.id), commonHeaders);
    return;
  }
  sendFailureTrail(res, wire, trail, 502);
}

function models(req: any, res: any): void {
  const data = listModels();
  if (req.headers['x-api-key'] !== undefined) {
    send(res, 200, { data: data.map(m => ({ type: 'model', id: m.id, display_name: m.display_name, created_at: '2026-01-01T00:00:00Z' })), has_more: false });
  } else send(res, 200, { object: 'list', data: data.map(m => ({ id: m.id, object: 'model', created: 1767225600, owned_by: m.provider })) });
}
async function start(): Promise<void> {
  if (process.argv.includes('--list')) {
    await new Promise<void>(resolve => process.stdout.write(JSON.stringify(catalog) + '\n', () => resolve()));
    return;
  }
  if (!envUrl || !gateway) throw new Error('MAKEFUN_ENV_URL and OPENAI_BASE_URL are required');
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://entry').pathname;
    if (req.method === 'GET' && path === '/v1/models') return models(req, res);
    if (req.method === 'POST' && path === '/v1/chat/completions') { void complete(req, res, 'openai'); return; }
    if (req.method === 'POST' && path === '/v1/messages') { void complete(req, res, 'anthropic'); return; }
    send(res, 404, errorBody(path === '/v1/messages' ? 'anthropic' : 'openai', 'Route not found'));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Listener has no port');
  const registration = await fetch(`${envUrl}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocol_version: 1, port: address.port, catalog }) });
  if (!registration.ok) throw new Error(`Registration failed: ${registration.status}`);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void fetch(`${envUrl}/work`).then(r => r.json()).then(work => {
      if (work.done === true) { clearInterval(timer); server.close(); process.exit(0); }
    }).catch(() => {}).finally(() => { busy = false; });
  }, 100);
}
start().catch(err => { process.stderr.write(`aggregator: ${err?.stack ?? err}\n`); process.exitCode = 1; });

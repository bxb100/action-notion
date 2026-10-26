const fs = require('fs');
const core = require('@actions/core');
const { Client } = require('@notionhq/client');

const TEXT_LIMIT = 2000; // Notion: max chars per rich_text object
const BLOCK_LIMIT = 100; // Notion: max children per request

// ---------- rich text / blocks ----------

function richText(text) {
  const s = String(text ?? '');
  if (!s) return [];
  const out = [];
  for (let i = 0; i < s.length; i += TEXT_LIMIT) {
    out.push({ type: 'text', text: { content: s.slice(i, i + TEXT_LIMIT) } });
  }
  return out;
}

const CODE_LANGS = new Set([
  'bash', 'c', 'c++', 'c#', 'css', 'dart', 'diff', 'docker', 'go', 'graphql', 'html', 'java',
  'javascript', 'json', 'kotlin', 'markdown', 'php', 'plain text', 'powershell', 'python',
  'ruby', 'rust', 'scala', 'shell', 'sql', 'swift', 'typescript', 'xml', 'yaml',
]);
const LANG_ALIAS = {
  js: 'javascript', ts: 'typescript', py: 'python', sh: 'shell', zsh: 'shell', yml: 'yaml',
  md: 'markdown', rb: 'ruby', rs: 'rust', cpp: 'c++', cs: 'c#', dockerfile: 'docker', text: 'plain text', txt: 'plain text',
};
function normLang(lang) {
  const l = (lang || '').trim().toLowerCase();
  const n = LANG_ALIAS[l] || l;
  return CODE_LANGS.has(n) ? n : 'plain text';
}

const block = (type, text, extra = {}) => ({
  object: 'block',
  type,
  [type]: { rich_text: richText(text), ...extra },
});

function markdownToBlocks(src) {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;

    if (!line.trim()) { i++; continue; }

    // fenced code
    if ((m = line.match(/^```(\S*)\s*$/))) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
      blocks.push(block('code', buf.join('\n'), { language: normLang(m[1]) }));
      continue;
    }
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      blocks.push(block(`heading_${m[1].length}`, m[2]));
    } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ object: 'block', type: 'divider', divider: {} });
    } else if ((m = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/))) {
      blocks.push(block('to_do', m[2], { checked: m[1].toLowerCase() === 'x' }));
    } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      blocks.push(block('bulleted_list_item', m[1]));
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      blocks.push(block('numbered_list_item', m[1]));
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      blocks.push(block('quote', m[1]));
    } else {
      blocks.push(block('paragraph', line.trim()));
    }
    i++;
  }
  return blocks;
}

function plainToBlocks(src) {
  return src
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => block('paragraph', p));
}

// ---------- properties ----------

const toList = (v) =>
  Array.isArray(v) ? v.map(String) : String(v).split(',').map((x) => x.trim()).filter(Boolean);

function toDate(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return { date: v }; // {start,end,time_zone}
  const s = String(v);
  if (s.includes('/')) {
    const [start, end] = s.split('/');
    return { date: { start: start.trim(), end: end.trim() } };
  }
  return { date: { start: s.trim() } };
}

function convertProperty(name, type, value) {
  const str = String(value ?? '');
  switch (type) {
    case 'title': return { title: richText(str) };
    case 'rich_text': return { rich_text: richText(str) };
    case 'number': {
      const n = Number(value);
      if (Number.isNaN(n)) throw new Error(`Column "${name}" expects a number, got: ${str}`);
      return { number: n };
    }
    case 'select': return { select: value === null || str === '' ? null : { name: str } };
    case 'status': return { status: { name: str } };
    case 'multi_select': return { multi_select: toList(value).map((n) => ({ name: n })) };
    case 'date': return toDate(value);
    case 'checkbox': return { checkbox: value === true || str.toLowerCase() === 'true' };
    case 'url': return { url: str };
    case 'email': return { email: str };
    case 'phone_number': return { phone_number: str };
    case 'people': return { people: toList(value).map((id) => ({ object: 'user', id })) };
    case 'relation': return { relation: toList(value).map((id) => ({ id })) };
    case 'files':
      return {
        files: toList(value).map((url) => ({
          name: url.split('/').pop() || 'file',
          type: 'external',
          external: { url },
        })),
      };
    default:
      throw new Error(`Column "${name}" has type "${type}", which is read-only or not supported.`);
  }
}

function buildProperties(schema, userProps, title) {
  const byName = schema;
  const lower = Object.fromEntries(Object.keys(schema).map((k) => [k.toLowerCase(), k]));
  const result = {};

  const resolve = (name) => {
    if (byName[name]) return name;
    if (lower[name.toLowerCase()]) return lower[name.toLowerCase()];
    throw new Error(
      `Column "${name}" does not exist in the database. Available columns: ${Object.keys(schema).join(', ')}`
    );
  };

  const entries = { ...userProps };
  if (title) {
    const titleCol = Object.keys(schema).find((k) => schema[k].type === 'title');
    if (!titleCol) throw new Error('Database has no title column.');
    if (!(titleCol in entries)) entries[titleCol] = title;
  }

  for (const [name, value] of Object.entries(entries)) {
    const real = resolve(name);
    result[real] = convertProperty(real, schema[real].type, value);
  }
  return result;
}

// ---------- main ----------

async function run() {
  const token = core.getInput('notion_token', { required: true });
  core.setSecret(token);
  const databaseId = core.getInput('database_id', { required: true });
  const title = core.getInput('title');
  const format = (core.getInput('content_format') || 'markdown').toLowerCase();

  let userProps = {};
  const rawProps = core.getInput('properties');
  if (rawProps) {
    try {
      userProps = JSON.parse(rawProps);
    } catch (e) {
      throw new Error(`"properties" is not valid JSON: ${e.message}`);
    }
    if (!userProps || typeof userProps !== 'object' || Array.isArray(userProps)) {
      throw new Error('"properties" must be a JSON object.');
    }
  }

  // page content: `content` wins, else read `content_file`
  let text = core.getInput('content', { trimWhitespace: false });
  const file = core.getInput('content_file');
  if (!text.trim() && file) {
    if (!fs.existsSync(file)) throw new Error(`content_file not found: ${file}`);
    text = fs.readFileSync(file, 'utf8');
  }

  const notion = new Client({
    auth: token,
    baseUrl: process.env.NOTION_API_BASE_URL || undefined, // optional: proxy / testing
  });

  const db = await notion.databases.retrieve({ database_id: databaseId });
  const properties = buildProperties(db.properties, userProps, title);

  const children = text.trim()
    ? format === 'plain' ? plainToBlocks(text) : markdownToBlocks(text)
    : [];

  const page = await notion.pages.create({
    parent: { database_id: databaseId },
    properties,
    children: children.slice(0, BLOCK_LIMIT),
  });

  for (let i = BLOCK_LIMIT; i < children.length; i += BLOCK_LIMIT) {
    await notion.blocks.children.append({
      block_id: page.id,
      children: children.slice(i, i + BLOCK_LIMIT),
    });
  }

  core.setOutput('page_id', page.id);
  core.setOutput('page_url', page.url);
  core.info(`Created page: ${page.url} (${children.length} blocks)`);
}

run().catch((err) => core.setFailed(err.message || String(err)));

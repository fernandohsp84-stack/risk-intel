/**
 * Risk Intel — gerador da edição diária
 *
 * Roda no GitHub Actions às 07:00 BRT. Consulta a API da Anthropic com busca
 * web real, monta o briefing dos temas fixos e grava dois arquivos:
 *   briefing.json  → lido pelo app ao abrir
 *   briefing.html  → corpo do e-mail
 *
 * Variáveis de ambiente obrigatórias:
 *   ANTHROPIC_API_KEY
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("ANTHROPIC_API_KEY não definida.");
  process.exit(1);
}

// ─── Temas fixos da edição ────────────────────────────────────────────
const TEMAS = [
  {
    id: "modelo",
    label: "Risco de Modelo",
    icon: "◈",
    accent: "#0071e3",
    tags: ["Validação de Modelos", "IFRS 9 & ECL", "Backtesting", "Governança de Modelos", "Stress Test"],
  },
  {
    id: "ia",
    label: "Risco de IA",
    icon: "⬡",
    accent: "#ff9500",
    tags: ["IA Generativa", "Regulação IA & BIS", "Viés Algorítmico", "Explainability (XAI)", "Cibersegurança & IA"],
  },
];

const SYS = `Você é especialista sênior em regulação bancária brasileira e internacional (BCB, CMN, BIS/BCBS, FSB). Você TEM acesso a busca web e DEVE usá-la para fundamentar os achados em documentos reais.

PROCESSO:
1. BUSQUE (2-3 buscas focadas): priorize bcb.gov.br, bis.org/bcbs/publ, fsb.org. Para crédito/inadimplência inclua serasaexperian.com.br. Para acadêmico use scholar.google.com (nunca ssrn.com direto — bloqueia bots).
2. EXTRAIA de cada documento real: número exato da norma, data, métrica concreta, URL de origem.
3. AUTO-REVISE antes de responder: descarte itens genéricos sem norma/métrica; verifique formato das referências (Res. BCB XXXX/AAAA, Circular X.XXX, BCBS dXXX); NUNCA invente norma, data ou URL.

CONFIDENCE: "alto"=URL real+conteúdo verificado · "médio"=norma existe, conteúdo não confirmado · "baixo"=sem fonte primária.

RETORNE APENAS este JSON (sem markdown, sem texto extra):
{"summary":"síntese executiva em 2 frases","items":[{"title":"título técnico","body":"análise em 3 frases: (1) referência encontrada, (2) conteúdo real, (3) implicação prática para um banco brasileiro","source":"nome da fonte","sourceCode":"BCB|BIS|CMN|FSB|FEBRABAN|SERASA|ITAU|BB","tag":"uma das tags fornecidas","date":"período real","relevance":"alto|médio|baixo","confidence":"alto|médio|baixo","normRef":"norma real ou vazio","metric":"métrica real ou vazio","url":"URL real ou vazio"}]}
Retorne 4 itens de ALTA qualidade.`;

// ─── Chamada à API ────────────────────────────────────────────────────
async function callClaude(userMsg, { maxTokens = 3000, maxSearches = 3 } = {}) {
  const body = {
    model: "claude-sonnet-4-5",
    max_tokens: maxTokens,
    system: SYS,
    messages: [{ role: "user", content: userMsg }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxSearches }],
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status} — ${txt.slice(0, 400)}`);
  }

  const data = await res.json();
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

// ─── Parsing tolerante ────────────────────────────────────────────────
function parseJSON(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(t); } catch {}
  const start = t.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; }
        }
      }
    }
  }
  return null;
}

function clean(s) {
  return String(s || "")
    .replace(/<cite[^>]*>([\s\S]*?)<\/cite>/gi, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/`{1,3}/g, "")
    .replace(/\[\d+\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Evita repetir as manchetes da edição anterior
function titulosAnteriores() {
  try {
    if (!existsSync("briefing.json")) return [];
    const prev = JSON.parse(readFileSync("briefing.json", "utf-8"));
    return (prev.editorias || []).flatMap((e) => (e.itens || []).map((i) => i.title)).slice(0, 12);
  } catch {
    return [];
  }
}

// ─── Montagem da edição ───────────────────────────────────────────────
async function main() {
  const hoje = new Date();
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(hoje);
  const anteriores = titulosAnteriores();
  const excl = anteriores.length
    ? `\n\nEVITE repetir estes títulos já publicados:\n${anteriores.map((t) => "- " + t).join("\n")}`
    : "";

  const editorias = [];
  const resumos = [];

  for (const tema of TEMAS) {
    console.log(`→ Gerando editoria: ${tema.label}`);
    try {
      const msg =
        `Tema de risco: ${tema.label}\n` +
        `Consulta: novidades regulatórias e de mercado mais relevantes dos últimos 30 dias\n` +
        `Cubra estas tags (use o campo "tag" de cada item): ${tema.tags.join(", ")}${excl}\n\n` +
        `Modo rápido: no máximo 3 buscas focadas e 4 itens. Body de 3 frases diretas.`;

      const raw = await callClaude(msg, { maxTokens: 3000, maxSearches: 3 });
      const parsed = parseJSON(raw);

      if (!parsed?.items?.length) {
        console.warn(`  ⚠ ${tema.label}: sem itens estruturados`);
        continue;
      }

      const itens = parsed.items.map((i) => ({
        title: clean(i.title),
        body: clean(i.body),
        source: i.source || "",
        sourceCode: i.sourceCode || "",
        tag: i.tag || "",
        themeId: tema.id,
        date: i.date || "",
        relevance: i.relevance || "alto",
        confidence: i.confidence || "médio",
        normRef: i.normRef || "",
        metric: i.metric || "",
        url: i.url || "",
      })).filter((i) => i.title && i.body);

      if (itens.length) {
        editorias.push({ themeId: tema.id, titulo: tema.label, itens });
        if (parsed.summary) resumos.push(clean(parsed.summary));
      }
      console.log(`  ✓ ${itens.length} itens`);
    } catch (err) {
      console.error(`  ✗ ${tema.label}: ${err.message}`);
    }
  }

  if (!editorias.length) {
    console.error("Nenhuma editoria gerada — abortando sem sobrescrever a edição anterior.");
    process.exit(1);
  }

  const briefing = {
    data: iso,
    edicao: "Edição do dia",
    gerado: new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    }).format(hoje),
    manchete: resumos.join(" "),
    editorias,
  };

  writeFileSync("briefing.json", JSON.stringify(briefing, null, 2), "utf-8");
  writeFileSync("briefing.html", montarEmail(briefing), "utf-8");

  const total = editorias.reduce((a, e) => a + e.itens.length, 0);
  console.log(`\n✓ Edição de ${iso}: ${editorias.length} editorias, ${total} itens.`);
}

// ─── Corpo do e-mail ──────────────────────────────────────────────────
function esc(s) {
  return String(s || "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function montarEmail(b) {
  const MESES = ["janeiro","fevereiro","março","abril","maio","junho",
                 "julho","agosto","setembro","outubro","novembro","dezembro"];
  const d = new Date(b.data + "T12:00:00");
  const dataLonga = `${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}`;
  const cor = { modelo: "#0071e3", ia: "#ff9500" };

  const corpo = b.editorias.map((ed) => {
    const accent = cor[ed.themeId] || "#0071e3";
    const artigos = ed.itens.map((i) => `
      <tr><td style="padding:16px 0;border-bottom:1px solid #e5e5ea">
        ${i.tag ? `<div style="font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${accent};margin-bottom:6px">${esc(i.tag)}</div>` : ""}
        <div style="font-family:Georgia,serif;font-size:17px;font-weight:600;line-height:1.35;color:#1d1d1f;margin-bottom:7px">${esc(i.title)}</div>
        <div style="font-size:14px;line-height:1.65;color:#48484a;margin-bottom:9px">${esc(i.body)}</div>
        <div style="font-size:11px;color:#8e8e93">
          ${i.source ? `<strong style="color:${accent};text-transform:uppercase;letter-spacing:.5px">${esc(i.source)}</strong>` : ""}
          ${i.date ? ` &middot; ${esc(i.date)}` : ""}
          ${i.normRef ? ` &middot; ${esc(i.normRef)}` : ""}
          ${i.metric ? ` &middot; ${esc(i.metric)}` : ""}
        </div>
        ${i.url ? `<div style="margin-top:7px"><a href="${esc(i.url)}" style="font-size:12px;color:${accent};text-decoration:none">Ver documento &rarr;</a></div>` : ""}
      </td></tr>`).join("");

    return `
      <tr><td style="padding-top:26px">
        <div style="border-bottom:2px solid #1d1d1f;padding-bottom:7px;margin-bottom:4px">
          <span style="font-size:12px;font-weight:800;letter-spacing:1.3px;text-transform:uppercase;color:#1d1d1f">${esc(ed.titulo)}</span>
        </div>
        <table width="100%" cellpadding="0" cellspacing="0">${artigos}</table>
      </td></tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Risk Intel — ${esc(dataLonga)}</title></head>
<body style="margin:0;padding:0;background:#f5f5f7">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7;padding:24px 0">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:12px;padding:28px 26px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">

  <tr><td style="border-bottom:2.5px solid #1d1d1f;padding-bottom:14px">
    <div style="font-size:10px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#8e8e93;padding-bottom:8px;border-bottom:1px solid #e5e5ea;margin-bottom:10px">${esc(dataLonga)}</div>
    <div style="font-family:Georgia,serif;font-size:32px;font-weight:700;letter-spacing:-.5px;color:#1d1d1f;text-align:center">Risk Intel</div>
    <div style="font-family:Georgia,serif;font-style:italic;font-size:13px;color:#8e8e93;text-align:center;margin-top:5px">Inteligência regulatória para gestão de riscos financeiros</div>
  </td></tr>

  ${b.manchete ? `<tr><td style="padding-top:20px">
    <div style="border-left:3px solid #0071e3;padding-left:15px">
      <div style="font-size:9px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#0071e3;margin-bottom:7px">Panorama do dia</div>
      <div style="font-family:Georgia,serif;font-size:17px;line-height:1.5;color:#1d1d1f">${esc(b.manchete)}</div>
    </div>
  </td></tr>` : ""}

  ${corpo}

  <tr><td style="border-top:2.5px solid #1d1d1f;padding-top:14px;margin-top:10px">
    <div style="font-size:11px;color:#8e8e93">
      Gerado automaticamente em ${esc(b.gerado)} &middot;
      <a href="https://fernandohsp84-stack.github.io/risk-intel/" style="color:#0071e3;text-decoration:none">Abrir o app</a>
    </div>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

main().catch((err) => {
  console.error("Falha:", err);
  process.exit(1);
});

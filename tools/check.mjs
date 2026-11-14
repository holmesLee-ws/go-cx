#!/usr/bin/env node
// 리포 관리자용 검사기. 학습자에게는 필요 없다.
// 검사: 커리큘럼 형식·선수 관계, 국내 근거 조문·글로벌 기준의 출처 대조(R10·R11), ISO 10001·10002·10004 등장(R10),
// 졸업 산출물 필수 절(R14), 미리 만든 시각 자료 없음(R5), 설정 JSON 유효성.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const read = (p) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");

const LEVELS = ["Explain", "Apply", "Evaluate", "Develop"];
const FIELDS = ["선수", "핵심 질문", "목표", "만들어 볼 것", "국내 근거", "글로벌 비교", "근거"];

function parseCurriculum(text) {
  const modules = new Map();
  const domestic = new Map();
  const global = new Map();
  const problems = [];
  const blocks = text.split(/^### /m).slice(1);
  for (const block of blocks) {
    const head = block.split("\n")[0];
    const m = head.match(/^([JVCSX]\d+) · (.+)$/);
    if (!m) { problems.push(`모듈 제목 형식 오류: ${head}`); continue; }
    const id = m[1];
    if (modules.has(id)) problems.push(`${id}: 중복 id`);
    const fields = {};
    for (const line of block.split("\n").slice(1)) {
      const f = line.match(/^- ([^:]+): (.+)$/);
      if (f) fields[f[1]] = f[2];
    }
    for (const name of FIELDS) if (!fields[name]) problems.push(`${id}: 「${name}」 없음`);
    if (fields["목표"] && !LEVELS.some((l) => fields["목표"].startsWith(`${l} — `))) problems.push(`${id}: 목표 수준 형식 오류`);
    const prereq = !fields["선수"] || fields["선수"] === "없음" ? [] : fields["선수"].split(",").map((s) => s.trim());
    modules.set(id, prereq);
    domestic.set(id, fields["국내 근거"] || "");
    global.set(id, fields["글로벌 비교"] || "");
  }
  for (const [id, prereq] of modules) for (const p of prereq) if (!modules.has(p)) problems.push(`${id}: 없는 선수 ${p}`);
  const state = new Map();
  const visit = (id, path) => {
    if (state.get(id) === 2 || !modules.has(id)) return;
    if (state.get(id) === 1) { problems.push(`선수 순환: ${[...path, id].join(" → ")}`); return; }
    state.set(id, 1);
    for (const p of modules.get(id)) visit(p, [...path, id]);
    state.set(id, 2);
  };
  for (const id of modules.keys()) visit(id, []);
  return { modules, domestic, global, problems };
}


// sources.md 표: | 법령·기준명 | 확인한 조문 | URL | 조회일 |
// 별표 표기: 「별표 1」, 「[별표 2]」, 「별표 Ⅱ」
const BYEOLPYO = /\[?별표 ?(\d+|[ⅠⅡⅢⅣⅤ]+)\]?/g;

function parseSources(text) {
  const rows = new Map();
  for (const line of text.split("\n")) {
    const c = line.split("|").map((s) => s.trim());
    if (c.length < 6 || !/^https?:\/\//.test(c[3]) || !/^\d{4}-\d{2}-\d{2}$/.test(c[4])) continue;
    const arts = new Set([...(c[2].match(/제\d+조(?:의\d+)?/g) || []), ...[...c[2].matchAll(BYEOLPYO)].map((m) => `별표${m[1]}`)]);
    rows.set(c[1], arts);
  }
  return rows;
}

// 지도 「국내 근거」 줄 문법: 「법령·기준 정식 명칭 제N조(조문 제목), … — 이 모듈에서 쓰는 장면」.
// 줄표(—) 뒤는 설명이라 이름 후보 검사에서 뺀다. 조문 번호는 줄 전체에서 대조한다.
// sources.md 이름 칸은 「정식 명칭(약칭)」을 허용한다. 지도 이름이 같거나, sources 이름이 「지도 이름(」로 시작하면 같은 법령이다.
function checkDomestic(domestic, sources) {
  const problems = [];
  const alias = new Map();
  for (const n of sources.keys()) { alias.set(n, n); const base = n.replace(/\([^()]*\)$/, "").trim(); if (base && !alias.has(base)) alias.set(base, n); }
  const names = [...alias.keys()].sort((a, b) => b.length - a.length);
  for (const [id, line] of domestic) {
    if (/^해당 없음/.test(line)) { if (!/^해당 없음 — .{8,}/.test(line)) problems.push(`${id}: 국내 근거 「해당 없음」의 이유가 없거나 짧음`); continue; }
    // 법령명 위치를 찾는다(긴 이름 우선, 겹침 제외)
    const hits = [];
    for (const n of names) {
      let i = -1;
      while ((i = line.indexOf(n, i + 1)) !== -1) if (!hits.some((h) => i < h.end && i + n.length > h.start)) hits.push({ name: alias.get(n), start: i, end: i + n.length });
    }
    hits.sort((a, b) => a.start - b.start);
    const refs = [...[...line.matchAll(/제\d+조(?:의\d+)?/g)].map((m) => ({ key: m[0], index: m.index })),
      ...[...line.matchAll(BYEOLPYO)].map((m) => ({ key: `별표${m[1]}`, index: m.index }))];
    for (const m of refs.map((r) => Object.assign([r.key], { index: r.index }))) {
      const owner = hits.filter((h) => h.end <= m.index).pop();
      if (!owner) { problems.push(`${id}: ${m[0]}의 법령명이 sources.md에 없음`); continue; }
      if (!sources.get(owner.name).has(m[0])) problems.push(`${id}: ${owner.name} ${m[0]}이 sources.md에서 확인되지 않음`);
    }
    // 줄표 앞 부분에서 괄호 설명을 지우고 쉼표로 나눈 조각을 법령·기준명으로 본다
    const head = line.split(" — ")[0].replace(/\([^)]*\)/g, "");
    for (const seg of head.split(/,/)) {
      const name = seg.split(/ 제\d| \[?별표/)[0].replace(/[「」]/g, "").trim();
      if (!name) continue;
      if (!alias.has(name)) problems.push(`${id}: 법령·기준명 「${name}」이 sources.md에 없음(정식 명칭으로 쓴다)`);
    }
  }
  return problems;
}

// 글로벌 비교 줄의 식별자(CFR·U.S.C.·EU 문서 번호·조항·기관명)가 sources.md 글로벌 표에 있는지 본다
const GLOBAL_KEYS = [/\d+ CFR (?:Part |§)?\d+(?:\.\d+)?/g, /\d+ U\.S\.C\. \d+/g, /(?:\(EU\) )?\d{4}\/\d+(?:\/EC|\/EU|\/EEC)?/g, /\b\d{2}\/\d{1,4}\/(?:EEC|EC)\b/g,
  /\bISO \d{4,5}(?:-\d)?\b/g, /\b(?:Consumer Rights Act 2015|Consumer Contracts Regulations 2013|DMCC Act 2024|Restatement \(Third\)|Magnuson-Moss|ACSI|SERVQUAL|COPC)\b/g];
function checkGlobal(global, sourcesText) {
  const problems = [];
  const rows = (sourcesText.split(/^## 글로벌/m)[1] || "").split("\n").filter((l) => /\| https?:\/\/\S+ \| \d{4}-\d{2}-\d{2} \|/.test(l));
  for (const [id, line] of global) {
    if (/^해당 없음/.test(line)) { if (!/^해당 없음 — .{8,}/.test(line)) problems.push(`${id}: 글로벌 비교 「해당 없음」의 이유가 없거나 짧음`); continue; }
    const found = [];
    for (const re of GLOBAL_KEYS) for (const m of line.matchAll(re)) {
      const key = m[0].replace(/^\(EU\) /, "").replace(/§(\d+)\.\d+$/, "Part $1");
      const alts = [m[0], key, key.replace(/ Part /, " §"), key.replace(/ §/, " Part ")];
      const hit = rows.filter((r) => alts.some((a) => r.includes(a)));
      if (!hit.length) problems.push(`${id}: 글로벌 근거 「${m[0]}」이 sources.md 글로벌 표에 없음`);
      found.push({ at: m.index, rows: hit });
    }
    if (!found.length) problems.push(`${id}: 글로벌 비교에 대조할 식별자가 없음(문서 번호·기관명을 적거나 「해당 없음 — 이유」)`);
    found.sort((a, b) => a.at - b.at);
    for (const m of line.matchAll(/제(\d+)a?조/g)) {
      const owner = found.filter((f) => f.at < m.index).pop();
      const n = m[0].replace(/^제|조$/g, "");
      if (owner && owner.rows.length && !owner.rows.some((r) => new RegExp(`Art\\. ${n}\\b`).test(r))) problems.push(`${id}: 글로벌 조항 ${m[0]}이 sources.md 해당 행에 없음`);
    }
  }
  return problems;
}

function checkGraduation(full) {
  const text = (full.split("## 졸업 산출물")[1] || "").split("\n## ")[0];
  const need = ["learner/projects/", "VOC 분류 체계", "불만 처리 절차서",
    "① 수집 채널", "② 분류 축", "③ 축별 코드", "④ 심각도", "⑤ 분류 품질", "⑥ 지표",
    "① 적용 범위", "② 접수", "③ 분류·우선순위", "④ 조사·해결안", "⑤ 회신·종결", "⑥ 상향", "⑦ 기록·개인정보", "⑧ 상담원 보호", "⑨ 분석·개선",
    "국내 근거", "URL", "조회일"];
  return need.filter((n) => !text.includes(n)).map((n) => `tutor/assessment.md 졸업 산출물 기준에 「${n}」 없음`);
}

// R10: 디스패처가 지정한 ISO 세 종이 어느 모듈의 글로벌 비교에 나오는가
function checkIsoCoverage(global) {
  const all = [...global.values()].join("\n");
  return ["ISO 10001", "ISO 10002", "ISO 10004"].filter((k) => !new RegExp(`${k}\\b`).test(all)).map((k) => `R10: ${k}가 어느 모듈의 글로벌 비교에도 없음`);
}

function findVisualAssets(files) {
  return files.filter((f) => /\.(x?html?|css|svgz?|png|jpe?g|gif|webp|avif|ico|bmp|pdf)$/i.test(f) || (/\.(m?js|cjs|jsx|tsx?)$/i.test(f) && f !== "tools/check.mjs"));
}

function findTemplateMarkup(name, text) {
  const hits = [];
  for (const m of text.matchAll(/(```|~~~)[\s\S]*?\1/g)) if (/<(!doctype|html|svg|style|canvas|script)\b/i.test(m[0])) hits.push(name);
  return hits;
}

function main() {
  const { modules, domestic, global, problems } = parseCurriculum(read("curriculum/map.md"));
  errors.push(...problems);
  if (!existsSync(join(root, "docs/build/sources.md"))) errors.push("docs/build/sources.md 없음");
  else {
    const src = read("docs/build/sources.md");
    errors.push(...checkDomestic(domestic, parseSources(src)), ...checkGlobal(global, src));
  }
  errors.push(...checkIsoCoverage(global));
  errors.push(...checkGraduation(read("tutor/assessment.md")));
  if (modules.size === 0) errors.push("모듈을 찾지 못함");

  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const f of findVisualAssets(files)) errors.push(`미리 만든 시각 자료 금지: ${f}`);
  for (const f of files.filter((x) => x.endsWith(".md") && existsSync(join(root, x)))) for (const n of findTemplateMarkup(f, read(f))) errors.push(`복사용 마크업 금지: ${n}`);

  for (const p of [".claude/settings.json", "learner-template/state.json"]) {
    try { JSON.parse(read(p)); } catch (e) { errors.push(`${p}: JSON 오류 ${e.constructor.name}`); }
  }
  if (!existsSync(join(root, "learner-template/log.md"))) errors.push("learner-template/log.md 없음");
  for (const s of readdirSync(join(root, ".claude/skills"))) {
    if (statSync(join(root, ".claude/skills", s)).isDirectory() && !existsSync(join(root, ".claude/skills", s, "SKILL.md"))) errors.push(`스킬 ${s}: SKILL.md 없음`);
  }
  if (!read(".gitignore").split("\n").includes("learner/")) errors.push(".gitignore에 learner/ 없음");

  if (errors.length) { console.error(errors.map((e) => `FAIL ${e}`).join("\n")); process.exit(1); }
  console.log(`OK 모듈 ${modules.size}개, 파일 ${files.length}개 검사`);
}

main();

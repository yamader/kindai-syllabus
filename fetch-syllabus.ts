// 金沢大学 Webシラバスの検索結果一覧を開講学域・研究科ごとに全件表示で取得し cache/<年度>/<学域コード>.html に保存、
// それらをまとめて docs/data/<年度>.json (GitHub Pages で公開) に変換する
// usage: bun fetch-syllabus.ts [年度]  /  node fetch-syllabus.ts [年度]
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";

const BASE = "https://eduweb.sta.kanazawa-u.ac.jp/portal/Public/Syllabus/";

// ASP.NET のセッションはリダイレクト途中でも Cookie を発行するので、手動で追いかける
function session() {
  const jar = new Map<string, string>();
  return async (url: string, body?: URLSearchParams) => {
    for (;;) {
      const r = await fetch(new URL(url, BASE), {
        method: body ? "POST" : "GET",
        body,
        headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") },
        redirect: "manual",
      });
      for (const c of r.headers.getSetCookie()) {
        const kv = c.split(";")[0];
        const i = kv.indexOf("=");
        jar.set(kv.slice(0, i), kv.slice(i + 1));
      }
      const loc = r.headers.get("location");
      if (!loc) {
        if (!r.ok) throw new Error(`${r.status} ${r.url}`);
        return { url: r.url, html: await r.text() };
      }
      url = new URL(loc, r.url).href;
      body = undefined;
    }
  };
}

// __VIEWSTATE 等の hidden を引き継いだポストバック用フォーム
const form = (html: string, fields: Record<string, string>) => {
  const f = new URLSearchParams();
  for (const [, k, v] of html.matchAll(/<input type="hidden" name="([^"]+)" id="[^"]*" value="([^"]*)"/g))
    f.set(k, v.replaceAll("&amp;", "&"));
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

const options = (html: string, id: string) =>
  [...(html.match(new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)</select>`))?.[1] ?? "").matchAll(/<option (selected="selected" )?value="([^"]*)">([^<]*)/g)]
    .map(([, sel, value, label]) => ({ value, label, selected: !!sel }));

async function fetchList(year: string, fac: string) {
  const req = session();
  const top = await req("SearchMain.aspx");
  const res = await req("SearchMain.aspx", form(top.html, {
    "ctl00$phContents$ddl_year": year,
    "ctl00$phContents$ddl_fac": fac,
    "ctl00$phContents$ddl_dpt": "NULL",
    "ctl00$phContents$ctl06$btnSearch": "検 索",
  }));
  if (!res.html.includes("ctl00_phContents_ucGrid_ddlLines")) return null; // 該当なし
  const all = await req(res.url, form(res.html, {
    __EVENTTARGET: "ctl00$phContents$ucGrid$ddlLines",
    __EVENTARGUMENT: "",
    "ctl00$phContents$ucGrid$ddlLines": "0",
  }));
  // 30件毎のページやエラーページをキャッシュしないように
  if (options(all.html, "ctl00_phContents_ucGrid_ddlLines").find((o) => o.selected)?.value !== "0")
    throw new Error(`全件表示に切り替わらなかった: fac=${fac}`);
  return all.html;
}

const decode = (s: string) =>
  s.replace(/&(#x?)?(\w+);/g, (m, num, v) =>
    num ? String.fromCodePoint(parseInt(v, num === "#x" ? 16 : 10))
      : ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[v] ?? m);
const text = (s: string) => decode(s.replace(/<[^>]+>/g, "")).trim();

// 一覧の GridView を行ごとに取り出す。構造が想定外なら壊れた JSON を出さずに落とす
function parse(html: string) {
  const grid = html.match(/id="ctl00_phContents_ucGrid_grv"[\s\S]*?<\/table>/)?.[0];
  if (!grid) throw new Error("一覧のテーブルが見つからない");
  return [...grid.matchAll(/<tr bgcolor[^>]*>([\s\S]*?)<\/tr>/g)].map(([row]) => {
    const td = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    // 富山大学の科目などは英語版リンクが href 無し
    const href = (s: string) => {
      const h = s.match(/href="([^"]+)"/)?.[1];
      return h ? new URL(decode(h), BASE).href : null;
    };
    const names = td[4]?.split("<br>").map(text) ?? [];
    if (td.length !== 8 || names.length < 2 || names.length > 3) throw new Error(`想定外の行: ${text(row)}`);
    return {
      code: text(td[1]), // 時間割コード
      faculty: names[0],
      department: names.length === 3 ? names[1] : null,
      title: names.at(-1)!,
      teachers: text(td[5]).split(/, (?![^\[]*\])/).filter(Boolean), // "[SURNAME, Given]" 内のカンマでは割らない
      term: text(td[6]),
      schedule: text(td[7]),
      url: { ja: href(td[2]), en: href(td[3]) },
    };
  });
}

const top = (await session()("SearchMain.aspx")).html;
const year = process.argv[2] ?? options(top, "ctl00_phContents_ddl_year").find((o) => o.selected)!.value;
const facs = options(top, "ctl00_phContents_ddl_fac").filter((o) => o.value !== "NULL");
await mkdir(`cache/${year}`, { recursive: true });
await mkdir("docs/data", { recursive: true });

const all: ReturnType<typeof parse> = [];
for (const { value, label } of facs) {
  const cache = `cache/${year}/${value}.html`;
  if (!existsSync(cache)) {
    const html = await fetchList(year, value);
    if (html === null) {
      console.log(`none  ${label}`);
      continue;
    }
    await writeFile(cache, html);
  }
  const rows = parse(await readFile(cache, "utf8"));
  all.push(...rows);
  console.log(`${label}: ${rows.length} 件`);
}

const json = `docs/data/${year}.json`;
// 1行1科目にして git の差分を読みやすくする
await writeFile(json, `[\n${all.map((r) => JSON.stringify(r)).join(",\n")}\n]\n`);
console.log(`${all.length} 件 -> ${json}`);

// 公開ページの年度プルダウン用 (新しい順)
const years = (await readdir("docs/data")).flatMap((f) => f.match(/^(\d{4})\.json$/)?.[1] ?? []).sort().reverse();
await writeFile("docs/data/years.json", JSON.stringify(years) + "\n");

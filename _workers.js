// sing-box Cloudflare Worker — Gcore CaaS 版
// 配合本项目使用：VLESS+WS 反代 + 多页面伪装站（软件下载站主题，全新设计）
//
// 与原 Scaleway 版的差异：
//   - Gcore CaaS 当前无"Private 容器 + IAM Token"端点鉴权（API Key 鉴权被官方禁用），
//     也没有源 IP 白名单。因此本版删除了对容器的 X-Auth-Token 鉴权头，
//     仅保留 Cloudflare Worker 侧的共享密钥闸门（X-Proxy-Token）作为唯一前置访问控制。
//   - 容器端点域名（*.cloud.gcore.dev）是公网的，靠"随机容器名 + 高熵 WS_PATH"做隐蔽，
//     降低被扫描发现概率（注意：这是隐蔽不是鉴权，详见 README 的安全说明）。
//
// 需要在 Worker Settings → Variables 中配置（3 个，比原版少 1 个 CONTAINER_TOKEN）：
//   WS_PATH         — WebSocket 路径，必须与 Gcore 容器的 WS_PATH 完全一致（高熵随机）
//   ORIGIN_DOMAIN   — Gcore CaaS 容器分配的域名（如 my-container-xxx-caas.<区域子域>.cloud.gcore.dev）
//   WS_SECRET       — 共享密钥，客户端 WS 请求需带 X-Proxy-Token 头且值与此一致才放行
// 建议 ORIGIN_DOMAIN / WS_SECRET 设为 Secret（加密存储）。WS_PATH 可普通变量。

const TOKEN_HEADER = 'X-Proxy-Token';

// 容错：用户在 Worker 变量里粘贴 ORIGIN_DOMAIN 时很可能带上 https:// 和末尾 /，
// 直接拿去当 hostname 会出错。这里统一只保留 host 部分。
function cleanOriginHost(raw) {
    return String(raw || '')
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/\/.*$/, '');
}

// 伪装站品牌：SoftVault — 开源软件下载站（全新设计，与代理/基础设施无关）
const BRAND = 'SoftVault';
const NAV = ['Home', 'Downloads', 'Docs', 'About', 'Contact'];
const NAV_HREF = ['/', '/downloads', '/docs', '/about', '/contact'];

function shell(title, main, active) {
    const navItems = NAV.map((n, i) =>
        `<a href="${NAV_HREF[i]}" class="${n === active ? 'active' : ''}">${n}</a>`
    ).join('\n            ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<link rel="icon" href="data:,">
<style>
${CSS}
</style>
</head>
<body>
<header>
<div class="wrap nav">
<a href="/" class="logo"><span class="mark">&diamondsuit;</span> ${BRAND}</a>
<div class="search"><input type="text" placeholder="Search 1,200+ apps..." aria-label="Search" disabled></div>
<nav class="links">${navItems}</nav>
</div>
</header>
<main class="wrap">
${main}
</main>
<footer>
<div class="wrap">
<span>&copy; 2026 ${BRAND}. Verified direct downloads from upstream sources.</span>
<span class="muted">All trademarks belong to their respective owners.</span>
</div>
</footer>
</body>
</html>`;
}

const CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --bg: #f7f8fb; --card: #ffffff; --ink: #0f172a; --muted: #64748b;
  --line: #e2e8f0; --brand: #4f46e5; --brand-soft: #eef2ff;
  --green: #16a34a; --radius: 12px;
}
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--bg); color: var(--ink); line-height: 1.6; }
.wrap { max-width: 1040px; margin: 0 auto; padding: 0 24px; }
header { background: var(--card); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 10; }
.nav { display: flex; align-items: center; gap: 24px; height: 64px; }
.logo { font-weight: 800; font-size: 1.15rem; color: var(--ink); text-decoration: none; display: flex; align-items: center; gap: 8px; }
.logo .mark { color: var(--brand); }
.search { flex: 1; max-width: 360px; }
.search input { width: 100%; padding: 9px 14px; border: 1px solid var(--line); border-radius: 999px;
  font-size: 0.9rem; background: var(--bg); color: var(--ink); }
.links { display: flex; gap: 6px; }
.links a { color: var(--muted); text-decoration: none; font-size: 0.9rem; padding: 7px 12px; border-radius: 8px; }
.links a:hover { background: var(--brand-soft); color: var(--brand); }
.links a.active { color: var(--brand); font-weight: 600; }
main { padding: 40px 24px 64px; }
.hero { text-align: center; padding: 32px 0 40px; }
.hero h1 { font-size: 2.1rem; letter-spacing: -0.02em; margin-bottom: 12px; }
.hero p { color: var(--muted); font-size: 1.05rem; max-width: 620px; margin: 0 auto 24px; }
.hero .cta { display: inline-flex; gap: 12px; }
.btn { display: inline-block; padding: 11px 22px; border-radius: 10px; font-size: 0.92rem; font-weight: 600;
  text-decoration: none; border: 1px solid transparent; cursor: pointer; }
.btn.primary { background: var(--brand); color: #fff; }
.btn.ghost { background: var(--card); border-color: var(--line); color: var(--ink); }
.chips { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 28px; }
.chip { background: var(--card); border: 1px solid var(--line); border-radius: 999px;
  padding: 6px 14px; font-size: 0.82rem; color: var(--muted); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 16px; margin-top: 8px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px; transition: box-shadow .15s; }
.card:hover { box-shadow: 0 8px 24px rgba(15,23,42,0.06); }
.card .name { font-weight: 700; font-size: 1.02rem; display: flex; justify-content: space-between; align-items: center; }
.card .ver { font-size: 0.75rem; color: var(--muted); font-weight: 500; }
.card .desc { color: var(--muted); font-size: 0.88rem; margin: 8px 0 14px; min-height: 42px; }
.badges { display: flex; gap: 6px; flex-wrap: wrap; }
.badge { font-size: 0.7rem; background: var(--brand-soft); color: var(--brand); padding: 3px 9px; border-radius: 6px; font-weight: 600; }
.section { margin-top: 56px; }
.section h2 { font-size: 1.3rem; margin-bottom: 4px; }
.section .lead { color: var(--muted); font-size: 0.95rem; margin-bottom: 20px; }
.features { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
.feature { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 20px; }
.feature h3 { font-size: 1rem; margin-bottom: 6px; }
.feature p { color: var(--muted); font-size: 0.88rem; }
.layout { display: grid; grid-template-columns: 220px 1fr; gap: 32px; margin-top: 8px; }
.side h3 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 10px; }
.side a { display: block; color: var(--ink); text-decoration: none; padding: 8px 12px; border-radius: 8px; font-size: 0.9rem; }
.side a:hover { background: var(--brand-soft); color: var(--brand); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 12px 8px; border-bottom: 1px solid var(--line); font-size: 0.9rem; }
th { color: var(--muted); font-weight: 600; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; }
.row .name { font-weight: 600; }
.dl { color: var(--brand); text-decoration: none; font-weight: 600; font-size: 0.85rem; }
.dl:hover { text-decoration: underline; }
.prose { max-width: 760px; }
.prose h1 { font-size: 1.8rem; margin-bottom: 8px; }
.prose h2 { font-size: 1.25rem; margin: 28px 0 8px; }
.prose p { color: var(--muted); margin-bottom: 14px; }
.prose code { background: var(--brand-soft); color: var(--brand); padding: 2px 7px; border-radius: 6px; font-size: 0.86em; }
.prose a { color: var(--brand); }
footer { border-top: 1px solid var(--line); background: var(--card); }
footer .wrap { display: flex; justify-content: space-between; align-items: center; padding: 24px; flex-wrap: wrap; gap: 8px; }
footer .muted { color: var(--muted); font-size: 0.82rem; }
@media (max-width: 720px) { .layout { grid-template-columns: 1fr; } .search { display: none; } }
`;

// ---------- 伪装页面内容 ----------

const HOME = shell(`${BRAND} — Verified Open-Source Software Downloads`, `
<div class="hero">
<h1>Download trusted open-source software</h1>
<p>SoftVault indexes ${'1,200+'} vetted desktop applications and links you straight to the official upstream builds &mdash; no installers bundled, no ads, no middlemen.</p>
<div class="cta">
<a href="/downloads" class="btn primary">Browse downloads</a>
<a href="/docs" class="btn ghost">How we verify</a>
</div>
<div class="chips">
<span class="chip">Development</span><span class="chip">Multimedia</span><span class="chip">Productivity</span>
<span class="chip">Security</span><span class="chip">Utilities</span><span class="chip">Networking</span>
</div>
</div>
<div class="section">
<h2>Popular this week</h2>
<p class="lead">Hand-picked stable releases, refreshed daily from upstream repositories.</p>
<div class="grid">
${appCard('7-Zip', '24.07', 'File archiver with one of the highest compression ratios available.', ['Windows','Linux'], '/downloads')}
${appCard('VLC media player', '3.0.21', 'Plays everything, streams everywhere &mdash; the universal media player.', ['Windows','macOS','Linux'], '/downloads')}
${appCard('Notepad++', '8.6.9', 'Fast, free source code editor and Notepad replacement.', ['Windows'], '/downloads')}
${appCard('LibreOffice', '24.8', 'Complete office suite, compatible with Microsoft Office documents.', ['Windows','macOS','Linux'], '/downloads')}
${appCard('OBS Studio', '30.2', 'Real-time video recording and live streaming software.', ['Windows','macOS','Linux'], '/downloads')}
${appCard('Audacity', '3.6', 'Multi-track audio editor and recorder for every platform.', ['Windows','macOS','Linux'], '/downloads')}
</div>
</div>
<div class="section">
<h2>Why SoftVault</h2>
<div class="features">
<div class="feature"><h3>Direct from source</h3><p>Every link points to the project's own release artifacts. We never re-host binaries.</p></div>
<div class="feature"><h3>Checksums verified</h3><p>SHA-256 digests listed alongside each release so you can confirm integrity.</p></div>
<div class="feature"><h3>No adware, ever</h3><p>Free of bundled toolbars, installers, and fake download buttons.</p></div>
</div>
</div>
`, 'Home');

const DOWNLOADS = shell(`Downloads &mdash; ${BRAND}`, `
<div class="section" style="margin-top:0">
<h2>All downloads</h2>
<p class="lead">Browse the full catalog. Each entry links to the official upstream build with a published checksum.</p>
<div class="layout">
<aside class="side">
<h3>Categories</h3>
<a href="/downloads">Development</a>
<a href="/downloads">Multimedia</a>
<a href="/downloads">Productivity</a>
<a href="/downloads">Security</a>
<a href="/downloads">Utilities</a>
<a href="/downloads">Networking</a>
</aside>
<div>
<table>
<thead><tr><th>Application</th><th>Version</th><th>Platform</th><th></th></tr></thead>
<tbody>
${dlRow('7-Zip','24.07','Win, Linux')}
${dlRow('VLC media player','3.0.21','Win, macOS, Linux')}
${dlRow('Notepad++','8.6.9','Win')}
${dlRow('LibreOffice','24.8','Win, macOS, Linux')}
${dlRow('OBS Studio','30.2','Win, macOS, Linux')}
${dlRow('Audacity','3.6','Win, macOS, Linux')}
${dlRow('HandBrake','1.8','Win, macOS, Linux')}
${dlRow('GIMP','2.10.38','Win, macOS, Linux')}
${dlRow('Inkscape','1.3.2','Win, macOS, Linux')}
${dlRow('FFmpeg','7.0','Win, macOS, Linux')}
</tbody>
</table>
</div>
</div>
</div>
`, 'Downloads');

const DOCS = shell(`Docs &mdash; ${BRAND}`, `
<div class="prose">
<h1>How we verify downloads</h1>
<p>SoftVault does not repackage or re-host any software. Each catalog entry references a release artifact published by the upstream project on its own infrastructure. Before an entry appears in the catalog, we run the following checks.</p>
<h2>1. Source provenance</h2>
<p>We confirm the binary is published from the project's official release channel &mdash; GitHub Releases, the project's own download mirror, or a recognized package registry. We never list repackaged third-party builds.</p>
<h2>2. Checksum publication</h2>
<p>Every release ships with a SHA-256 digest published by the maintainers. We surface that digest on the download page so you can compare it locally:</p>
<p><code>sha256sum ~/Downloads/app-24.07-installer.exe</code></p>
<h2>3. Signature where available</h2>
<p>For projects that sign their releases (GnuPG, Authenticode, or macOS notarization), we note the signing key fingerprint and link to the maintainer's published key.</p>
<h2>Reporting a problem</h2>
<p>If a digest does not match or a link is stale, let us know via the <a href="/contact">contact page</a>. We refresh the catalog daily, so broken links are usually fixed within hours.</p>
</div>
`, 'Docs');

const ABOUT = shell(`About &mdash; ${BRAND}`, `
<div class="prose">
<h1>About ${BRAND}</h1>
<p>${BRAND} is a small, independent directory of free and open-source desktop software for Windows, macOS, and Linux. We started SoftVault because too many "download" sites on the internet are little more than adware delivery vehicles &mdash; bundled installers, fake download buttons, and outdated versions.</p>
<p>Our rule is simple: link to the official upstream build, list the maintainer's published checksum, and get out of the way. We do not host any files ourselves, which means you always receive the latest version straight from the people who built it.</p>
<p>The catalog covers everyday tools &mdash; archivers, media players, editors, and office suites &mdash; plus a growing set of development and networking utilities. Suggestions for new entries are welcome on the <a href="/contact">contact page</a>.</p>
<h2>Principles</h2>
<p><strong>No re-hosting.</strong> Binaries live on the upstream project's own infrastructure.<br>
<strong>No advertising.</strong> The site is funded by the maintainers and community, not by ad networks.<br>
<strong>Verifiable.</strong> Every release links to a published SHA-256 you can check yourself.</p>
<p><a href="/">&larr; Back to home</a></p>
</div>
`, 'About');

const CONTACT = shell(`Contact &mdash; ${BRAND}`, `
<div class="prose">
<h1>Contact</h1>
<p>Found a broken link, a mismatched checksum, or want to suggest an application for the catalog? Use the form below. We read everything, though response times vary.</p>
<h2>Report a stale or unsafe download</h2>
<p>Include the application name, the version you expected, and the checksum you observed. Reports are reviewed and catalog entries updated, usually within a few hours of the next daily refresh.</p>
<p class="muted" style="font-size:0.85rem">This page is a static demo &mdash; the form below is not wired up.</p>
<form onsubmit="return false" style="display:grid;gap:10px;max-width:440px;margin-top:8px">
<input type="text" placeholder="Your name" style="padding:10px 12px;border:1px solid var(--line);border-radius:8px">
<input type="email" placeholder="Email address" style="padding:10px 12px;border:1px solid var(--line);border-radius:8px">
<textarea placeholder="Message" rows="5" style="padding:10px 12px;border:1px solid var(--line);border-radius:8px;font-family:inherit"></textarea>
<button class="btn primary" type="submit">Send message</button>
</form>
</div>
`, 'Contact');

// 直接命中 WS_PATH（无密钥 / 非 WebSocket 升级）时返回的"下载直链"伪装页
const FILE_ACCESS = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Your download is ready &mdash; ${BRAND}</title>
<link rel="icon" href="data:,">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f7f8fb; color: #0f172a; }
.wrap { max-width: 560px; margin: 80px auto; padding: 0 24px; text-align: center; }
h1 { font-size: 1.4rem; margin-bottom: 8px; }
.muted { color: #64748b; font-size: 0.92rem; margin-bottom: 28px; }
.card { background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 28px; text-align: left; }
.row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #eef2f6; font-size: 0.9rem; }
.row:last-child { border-bottom: 0; }
.row span:first-child { color: #64748b; }
.btn { display: inline-block; margin-top: 24px; background: #4f46e5; color: #fff; text-decoration: none; padding: 12px 26px; border-radius: 10px; font-weight: 600; }
.note { color: #94a3b8; font-size: 0.8rem; margin-top: 22px; }
</style>
</head>
<body>
<div class="wrap">
<h1>Your download is ready</h1>
<p class="muted">Here is the verified direct link for your selected file.</p>
<div class="card">
<div class="row"><span>File</span><span>app-release-latest.exe</span></div>
<div class="row"><span>Size</span><span>48.2 MB</span></div>
<div class="row"><span>SHA-256</span><span>a3f9...c1e2 (truncated)</span></div>
<div class="row"><span>Source</span><span>Official upstream mirror</span></div>
</div>
<a href="#" class="btn">Start download</a>
<p class="note">Direct links are rate-limited and bound to the source repository. If the link has expired, return to the catalog and re-select the file.</p>
</div>
</body>
</html>`;

const NOT_FOUND = shell(`Page not found &mdash; ${BRAND}`, `
<div class="prose" style="text-align:center">
<h1>404</h1>
<p>The page you are looking for is not in the catalog.</p>
<p><a href="/">Return to home</a></p>
</div>
`, '');

function appCard(name, ver, desc, platforms, href) {
    const badges = platforms.map(p => `<span class="badge">${p}</span>`).join('');
    return `<div class="card">
<div class="name"><span>${name}</span><span class="ver">v${ver}</span></div>
<div class="desc">${desc}</div>
<div class="badges">${badges}</div>
<a href="${href}" class="dl" style="display:inline-block;margin-top:12px">Download &rarr;</a>
</div>`;
}

function dlRow(name, ver, platform) {
    return `<tr class="row"><td class="name">${name}</td><td>v${ver}</td><td>${platform}</td><td><a href="/downloads" class="dl">Get</a></td></tr>`;
}

const PAGES = { home: HOME, downloads: DOWNLOADS, docs: DOCS, about: ABOUT, contact: CONTACT };

export default {
    async fetch(request, env) {
        // ---- 0. 环境变量校验：缺失直接 503，避免反代到 undefined ----
        if (!env.WS_PATH || !env.ORIGIN_DOMAIN || !env.WS_SECRET) {
            return new Response('service unavailable', { status: 503 });
        }

        let url = new URL(request.url);

        // ============================================================
        // 1. 核心代理逻辑：仅转发带共享密钥的合法 WebSocket 升级请求
        //    Gcore 无端点鉴权，X-Proxy-Token 闸门是唯一前置访问控制，
        //    无凭据请求命中 WS_PATH 一律返回伪装页，不转发到容器。
        // ============================================================
        if (url.pathname === env.WS_PATH) {
            // 1a. 共享密钥闸门
            if (request.headers.get(TOKEN_HEADER) !== env.WS_SECRET) {
                return new Response(FILE_ACCESS, {
                    headers: { 'Content-Type': 'text/html;charset=UTF-8' }
                });
            }

            // 1b. 校验是否为完整的 WebSocket 升级请求
            const upgradeHeader = request.headers.get('Upgrade');
            const connectionHeader = request.headers.get('Connection');
            const wsKey = request.headers.get('Sec-WebSocket-Key');
            if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket'
                || !wsKey || !connectionHeader || !connectionHeader.toLowerCase().includes('upgrade')) {
                return new Response(FILE_ACCESS, {
                    headers: { 'Content-Type': 'text/html;charset=UTF-8' }
                });
            }

            // 1c. 合法 WS 升级 → 反代到 Gcore CaaS 容器
            //     Gcore 无 Private/IAM 鉴权，故不再设置 X-Auth-Token；
            //     仅覆写 Host，并删除共享密钥头避免泄露到容器。
            const originHost = cleanOriginHost(env.ORIGIN_DOMAIN);
            url.protocol = 'https:';
            url.hostname = originHost;

            let newHeaders = new Headers(request.headers);
            newHeaders.set('Host', originHost);
            newHeaders.delete(TOKEN_HEADER);

            let new_request = new Request(url, {
                method: request.method,
                headers: newHeaders,
                body: request.body,
                redirect: request.redirect
            });

            // WebSocket 升级响应必须原样返回，不能用 new Response() 包装，否则握手失败
            return fetch(new_request);
        }

        // ============================================================
        // 2. 站点辅助文件：robots.txt / favicon
        // ============================================================
        if (url.pathname === '/robots.txt') {
            return new Response(
                'User-agent: *\nAllow: /\n',
                { headers: { 'Content-Type': 'text/plain;charset=UTF-8' } }
            );
        }
        if (url.pathname === '/favicon.ico') {
            return new Response(null, { status: 204 });
        }

        // ============================================================
        // 3. 多页面伪装站路由
        // ============================================================
        switch (url.pathname) {
            case '/':
                return html(PAGES.home);
            case '/downloads':
                return html(PAGES.downloads);
            case '/docs':
                return html(PAGES.docs);
            case '/about':
                return html(PAGES.about);
            case '/contact':
                return html(PAGES.contact);
            default:
                return html(NOT_FOUND, 404);
        }
    }
};

function html(body, status = 200) {
    return new Response(body, {
        status,
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
}

#!/usr/bin/env node
/**
 * Syncs the PROJECTS and TECH sections of README.md with this account's
 * live public repos. Run by .github/workflows/update-readme.yml.
 *
 * A repo is featured in "Featured Projects" if it meets ANY of:
 *   - more than 5 commits on the default branch
 *   - has a homepage/topic/README link pointing at medium.com
 *   - has a package.json whose package name is published on npm
 *   - has a vercel.json (or .vercel) at its root, i.e. a configured Vercel build
 *
 * The Tech Stack badges are built from ALL public repos (not just featured
 * ones), since that section is meant to reflect overall skills, not just
 * the shipped highlights.
 *
 * Requires Node 20+ (uses global fetch) and a GITHUB_TOKEN env var
 * (the workflow passes the default Actions token automatically).
 */

const fs = require('fs');
const path = require('path');

const OWNER = process.env.GITHUB_REPOSITORY_OWNER || 'tranvo-dev';
const TOKEN = process.env.GITHUB_TOKEN;
const README_PATH = path.join(process.cwd(), 'README.md');
const MIN_COMMITS = 5;

// Repos to never list (the profile repo itself; add others by name if needed)
const SKIP_REPOS = new Set([OWNER.toLowerCase()]);

// Known language -> shields.io badge. Unknown languages fall back to a
// plain grey badge so new repos still show up without editing this file.
const LANGUAGE_BADGES = {
    Java: 'Java-ED8B00?style=flat-square&logo=openjdk&logoColor=white',
    TypeScript: 'TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white',
    JavaScript: 'JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black',
    HTML: 'HTML5-E34F26?style=flat-square&logo=html5&logoColor=white',
    CSS: 'CSS3-1572B6?style=flat-square&logo=css3&logoColor=white',
    Python: 'Python-3776AB?style=flat-square&logo=python&logoColor=white',
    Dockerfile: 'Docker-2496ED?style=flat-square&logo=docker&logoColor=white',
    Shell: 'Shell-4EAA25?style=flat-square&logo=gnu-bash&logoColor=white',
    Kotlin: 'Kotlin-7F52FF?style=flat-square&logo=kotlin&logoColor=white',
    Swift: 'Swift-FA7343?style=flat-square&logo=swift&logoColor=white',
    Dart: 'Dart-0175C2?style=flat-square&logo=dart&logoColor=white',
    Go: 'Go-00ADD8?style=flat-square&logo=go&logoColor=white',
    Vue: 'Vue.js-4FC08D?style=flat-square&logo=vuedotjs&logoColor=white',
};

async function githubApi(endpoint) {
    return fetch(`https://api.github.com${endpoint}`, {
        headers: {
            Authorization: `Bearer ${TOKEN}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        },
    });
}

async function fetchPublicRepos() {
    const res = await githubApi(`/users/${OWNER}/repos?type=owner&per_page=100&sort=pushed`);
    if (!res.ok) throw new Error(`Failed to list repos: ${res.status}`);
    const repos = await res.json();
    return repos.filter(
        (r) => !r.private && !r.fork && !r.archived && !SKIP_REPOS.has(r.name.toLowerCase())
    );
}

// Total commits on the default branch, via the Link-header paging trick:
// with per_page=1, the "last page" number equals the total commit count.
async function getCommitCount(repoName) {
    const res = await githubApi(`/repos/${OWNER}/${repoName}/commits?per_page=1`);
    if (!res.ok) return 0; // e.g. empty repo
    const link = res.headers.get('link');
    if (!link) {
        const body = await res.json();
        return body.length;
    }
    const match = link.match(/[?&]page=(\d+)>;\s*rel="last"/);
    return match ? parseInt(match[1], 10) : 1;
}

// Root directory listing, used to spot vercel.json / package.json in one
// call instead of guessing file paths individually.
async function getRootFiles(repoName) {
    const res = await githubApi(`/repos/${OWNER}/${repoName}/contents/`);
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body) ? body : [];
}

async function isPublishedOnNpm(packageJsonFile) {
    if (!packageJsonFile?.download_url) return false;
    try {
        const pkgRes = await fetch(packageJsonFile.download_url);
        if (!pkgRes.ok) return false;
        const pkg = await pkgRes.json();
        if (!pkg.name || pkg.private) return false;
        const npmRes = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`);
        return npmRes.ok;
    } catch {
        return false;
    }
}

async function mentionsMedium(repo, readmeFile) {
    if (repo.homepage && repo.homepage.includes('medium.com')) return true;
    if ((repo.topics || []).includes('medium')) return true;
    if (!readmeFile?.download_url) return false;
    try {
        const res = await fetch(readmeFile.download_url);
        if (!res.ok) return false;
        const text = await res.text();
        return text.includes('medium.com');
    } catch {
        return false;
    }
}

async function qualifies(repo) {
    const [commitCount, rootFiles] = await Promise.all([
        getCommitCount(repo.name),
        getRootFiles(repo.name),
    ]);

    if (commitCount > MIN_COMMITS) return true;

    const hasVercelConfig = rootFiles.some((f) => f.name === 'vercel.json' || f.name === '.vercel');
    if (hasVercelConfig) return true;

    const packageJsonFile = rootFiles.find((f) => f.name === 'package.json');
    if (await isPublishedOnNpm(packageJsonFile)) return true;

    const readmeFile = rootFiles.find((f) => /^readme/i.test(f.name));
    if (await mentionsMedium(repo, readmeFile)) return true;

    return false;
}

// Name + description only, per the "Featured Projects" format.
function buildProjectsSection(repos) {
    if (repos.length === 0) return '_No qualifying public projects yet._';
    return repos
        .map((r) => `- **[${r.name}](${r.html_url})** — ${r.description ? r.description.trim() : 'No description yet.'}`)
        .join('\n');
}

function buildTechStackSection(repos) {
    const counts = {};
    for (const r of repos) {
        if (!r.language) continue;
        counts[r.language] = (counts[r.language] || 0) + 1;
    }
    const sorted = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    if (sorted.length === 0) return '_No languages detected yet._';

    return sorted
        .map((lang) => {
            const badge = LANGUAGE_BADGES[lang];
            const src = badge
                ? `https://img.shields.io/badge/${badge}`
                : `https://img.shields.io/badge/${encodeURIComponent(lang)}-333333?style=flat-square`;
            return `  <img src="${src}" alt="${lang}" />`;
        })
        .join('\n');
}

function replaceBetween(content, marker, replacement) {
    const start = `<!-- ${marker}:START -->`;
    const end = `<!-- ${marker}:END -->`;
    const pattern = new RegExp(`${start}[\\s\\S]*?${end}`);
    if (!pattern.test(content)) {
        throw new Error(`Markers ${start} / ${end} not found in README.md`);
    }
    return content.replace(pattern, `${start}\n${replacement}\n${end}`);
}

async function main() {
    if (!TOKEN) throw new Error('GITHUB_TOKEN is not set');
    const allRepos = await fetchPublicRepos();

    const flags = await Promise.all(allRepos.map(qualifies));
    const featured = allRepos.filter((_, i) => flags[i]);

    let readme = fs.readFileSync(README_PATH, 'utf8');
    readme = replaceBetween(readme, 'PROJECTS', buildProjectsSection(featured));
    readme = replaceBetween(readme, 'TECH', buildTechStackSection(allRepos));

    fs.writeFileSync(README_PATH, readme);
    console.log(`${featured.length}/${allRepos.length} public repos qualified for Featured Projects.`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
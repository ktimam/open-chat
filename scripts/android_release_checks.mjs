import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const requiredWorkflows = Object.freeze([
    "frontend.yaml",
    "backend.yaml",
    "on_device_model_security.yaml",
    "openchat_pr2_security.yaml",
]);

export function releaseCheckContext(environment, checkoutSha) {
    const { GITHUB_REPOSITORY: repository, GITHUB_SHA: sha, GITHUB_API_URL: api } = environment;
    if (
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "") ||
        repository !== repository.trim() ||
        repository.split("/").some((part) => part === "." || part === "..") ||
        !/^[a-f0-9]{40}$/u.test(sha ?? "") ||
        checkoutSha !== sha ||
        api !== "https://api.github.com"
    ) {
        throw new Error(
            "Release checks require the exact checked-out GitHub commit and supported API origin.",
        );
    }
    return { repository, sha };
}

function completePage(payload, field) {
    if (
        !Number.isSafeInteger(payload?.total_count) ||
        payload.total_count < 1 ||
        payload.total_count > 100 ||
        !Array.isArray(payload[field]) ||
        payload[field].length !== payload.total_count
    ) {
        throw new Error(`Missing, truncated or invalid ${field} evidence; release blocked.`);
    }
    return payload[field];
}

export function latestSuccessfulRun(payload, workflow, context) {
    if (!requiredWorkflows.includes(workflow)) throw new Error("Unknown required workflow.");
    const runs = completePage(payload, "workflow_runs");
    for (const run of runs) {
        if (
            run.head_sha !== context.sha ||
            run.path !== `.github/workflows/${workflow}` ||
            run.repository?.full_name !== context.repository ||
            run.head_repository?.full_name !== context.repository ||
            !Number.isSafeInteger(run.id) ||
            run.id <= 0 ||
            !Number.isSafeInteger(run.run_number) ||
            run.run_number <= 0 ||
            !Number.isSafeInteger(run.run_attempt) ||
            run.run_attempt <= 0
        ) {
            throw new Error(`Invalid exact-source evidence for ${workflow}.`);
        }
    }
    const latest = [...runs].sort(
        (a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt,
    )[0];
    // PR runs can test a synthetic merge rather than head_sha. Require a branch/dispatch run.
    if (
        !["push", "workflow_dispatch"].includes(latest.event) ||
        latest.status !== "completed" ||
        latest.conclusion !== "success"
    ) {
        throw new Error(`Latest ${workflow} run has not passed for the release commit.`);
    }
    return latest;
}

export function assertSuccessfulJobs(payload, run, context) {
    const jobs = completePage(payload, "jobs");
    for (const job of jobs) {
        if (
            job.run_id !== run.id ||
            job.head_sha !== context.sha ||
            job.status !== "completed" ||
            job.conclusion !== "success"
        ) {
            throw new Error(
                "Every required workflow job must pass; skipped jobs are not release evidence.",
            );
        }
    }
}

export async function verifyHostedChecks(context, token, request = fetch) {
    if (typeof token !== "string" || !token.trim())
        throw new Error("GitHub Actions read token is required.");
    const read = async (path) => {
        const response = await request(
            `https://api.github.com/repos/${context.repository}/actions/${path}`,
            {
                headers: {
                    Accept: "application/vnd.github+json",
                    Authorization: `Bearer ${token}`,
                    "X-GitHub-Api-Version": "2022-11-28",
                },
                redirect: "error",
                signal: AbortSignal.timeout(15_000),
            },
        ).catch(() => {
            throw new Error("Hosted release checks request failed.");
        });
        if (!response.ok)
            throw new Error(`Hosted release checks unavailable (HTTP ${response.status}).`);
        return response.json().catch(() => {
            throw new Error("Invalid hosted release checks response.");
        });
    };
    return Promise.all(
        requiredWorkflows.map(async (workflow) => {
            const runs = await read(
                `workflows/${workflow}/runs?head_sha=${context.sha}&per_page=100`,
            );
            const run = latestSuccessfulRun(runs, workflow, context);
            const jobs = await read(`runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
            assertSuccessfulJobs(jobs, run, context);
            return { workflow, runId: run.id, attempt: run.run_attempt };
        }),
    );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const git = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
        if (git.status !== 0) throw new Error("Cannot verify checked-out release commit.");
        const context = releaseCheckContext(process.env, git.stdout.trim());
        const results = await verifyHostedChecks(context, process.env.GITHUB_TOKEN);
        for (const result of results)
            console.log(
                `${result.workflow}: passed run ${result.runId}, attempt ${result.attempt}`,
            );
    } catch (error) {
        // Never print response bodies, request objects, or tokens.
        console.error(`Android prerequisite checks failed: ${error.message}`);
        process.exitCode = 1;
    }
}

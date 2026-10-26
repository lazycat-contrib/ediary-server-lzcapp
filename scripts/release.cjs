const fs = require('node:fs');
const crypto = require('node:crypto');

function validateRun(run, repository, branch, workflowID) {
  if (run.workflow_id !== workflowID || run.head_branch !== branch ||
      run.head_repository?.full_name?.toLowerCase() !== repository.toLowerCase() ||
      !['push', 'workflow_dispatch'].includes(run.event) || run.conclusion !== 'success') {
    throw new Error('Only a successful trusted-branch push/manual build from the configured source workflow is accepted');
  }
}

async function selectSource({github, core}) {
  const repository = process.env.SOURCE_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) {
    throw new Error('Set the LPK_SOURCE_REPOSITORY Actions secret to owner/repo');
  }
  const [owner, repo] = repository.split('/');
  const branch = process.env.SOURCE_BRANCH || 'main';
  const workflow = await github.rest.actions.getWorkflow({owner, repo, workflow_id: 'lazycat.yml'});
  const requested = process.env.SOURCE_RUN_ID || '';
  let run;
  if (requested) {
    if (!/^[1-9]\d*$/.test(requested) || !Number.isSafeInteger(Number(requested))) throw new Error('Invalid source run ID');
    run = (await github.rest.actions.getWorkflowRun({owner, repo, run_id: Number(requested)})).data;
  } else {
    const runs = await github.rest.actions.listWorkflowRuns({owner, repo, workflow_id: workflow.data.id, branch, event: 'push', status: 'success', per_page: 1});
    run = runs.data.workflow_runs[0];
    if (!run) throw new Error('No successful push build is available on the configured source branch');
  }
  validateRun(run, repository, branch, workflow.data.id);
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {owner, repo, run_id: run.id, per_page: 100});
  const matches = artifacts.filter(a => /^lpk-\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(a.name));
  if (matches.length !== 1 || matches[0].expired) throw new Error('Expected exactly one unexpired versioned LPK artifact; rebuild the source workflow if it expired');
  core.setOutput('run-id', String(run.id));
  core.setOutput('artifact-name', matches[0].name);
  core.setOutput('version', matches[0].name.slice(4));
}

async function assetBytes(github, owner, repo, asset) {
  const response = await github.request('GET /repos/{owner}/{repo}/releases/assets/{asset_id}', {
    owner, repo, asset_id: asset.id, headers: {accept: 'application/octet-stream'},
  });
  return Buffer.from(response.data);
}

async function ensureAsset(github, owner, repo, releaseID, existing, name, bytes) {
  const wanted = 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
  let asset = existing.find(a => a.name === name);
  if (!asset) {
    asset = (await github.rest.repos.uploadReleaseAsset({
      owner, repo, release_id: releaseID, name, data: bytes,
      headers: {'content-type': 'application/octet-stream', 'content-length': bytes.length},
    })).data;
  }
  // Read back the actual remote bytes, including when recovering a partial run.
  const actual = 'sha256:' + crypto.createHash('sha256').update(await assetBytes(github, owner, repo, asset)).digest('hex');
  if (wanted !== actual) throw new Error(`Release asset ${name} differs from the verified LPK/checksum; existing assets are never overwritten`);
  return asset;
}

async function publishedAssetURL(github, owner, repo, assetID, tag, filename) {
  // Draft assets have temporary /untagged-* URLs. Read fresh metadata only
  // after the Release is published; never pass the draft response to a store.
  const {data: asset} = await github.rest.repos.getReleaseAsset({owner, repo, asset_id: assetID});
  const url = new URL(asset.browser_download_url);
  const expected = `/${owner}/${repo}/releases/download/${tag}/${filename}`;
  if (url.origin !== (process.env.GITHUB_SERVER_URL || 'https://github.com') ||
      decodeURIComponent(url.pathname) !== expected || url.search || url.hash) {
    throw new Error('Release asset does not have the expected published version URL');
  }
  return asset.browser_download_url;
}

async function publishRelease({github, context, core}) {
  const {owner, repo} = context.repo;
  const version = process.env.LPK_VERSION;
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version || '')) throw new Error('Invalid release version');
  const tag = 'v' + version;
  let release;
  try {
    release = (await github.rest.repos.getReleaseByTag({owner, repo, tag})).data;
  } catch (error) {
    if (error.status !== 404) throw error;
    release = (await github.rest.repos.createRelease({
      owner, repo, tag_name: tag, target_commitish: context.sha, draft: true,
      name: `eDiary 服务端 ${tag}`,
      body: `eDiary 服务端 ${tag}\n\n应用更新至 ${version}。\n\n提供已构建的 LPK 安装包及 SHA256 校验文件。`,
    })).data;
  }
  const assets = await github.paginate(github.rest.repos.listReleaseAssets, {owner, repo, release_id: release.id, per_page: 100});
  const lpk = fs.readFileSync(process.env.LPK_PATH);
  if (crypto.createHash('sha256').update(lpk).digest('hex') !== process.env.LPK_SHA256) throw new Error('Local LPK changed after validation');
  const filename = `cloud.lazycat.app.ediary-server-${tag}.lpk`;
  const asset = await ensureAsset(github, owner, repo, release.id, assets, filename, lpk);
  await ensureAsset(github, owner, repo, release.id, assets, 'checksums.txt', fs.readFileSync('dist/checksums.txt'));
  if (release.draft) release = (await github.rest.repos.updateRelease({owner, repo, release_id: release.id, draft: false})).data;
  core.setOutput('download-url', await publishedAssetURL(github, owner, repo, asset.id, tag, filename));
  core.setOutput('changelog', release.body || `Release ${version}`);
  core.summary.addHeading('LPK published').addTable([
    [{data: 'Package', header: true}, {data: 'Version', header: true}, {data: 'SHA256', header: true}],
    ['cloud.lazycat.app.ediary-server', version, process.env.LPK_SHA256],
  ]).addLink('GitHub Release', release.html_url);
  await core.summary.write();
}

module.exports = {validateRun, selectSource, ensureAsset, publishedAssetURL, publishRelease};

import { execSync } from 'child_process';

// Get repo from arguments or use a default
const repo = process.argv[2] || "owner/repo";
if (repo === "owner/repo") {
  console.log("Usage: node calculate_wasted_time.js <owner/repo>");
  console.log("Example: node calculate_wasted_time.js facebook/react");
  process.exit(1);
}

console.log(`\n🔍 Analyzing recent PRs for ${repo} to find time wasted on re-approvals...\n`);

try {
  // Fetch the last 50 merged PRs
  const prsJson = execSync(`gh pr list --repo ${repo} --state merged --limit 50 --json number,title,url`, { encoding: 'utf-8' });
  const prs = JSON.parse(prsJson);

  let totalWastedMs = 0;
  let reApprovalCount = 0;

  for (const pr of prs) {
    // Fetch the timeline of events for the PR
    const timelineJson = execSync(`gh api repos/${repo}/issues/${pr.number}/timeline --paginate -H "Accept: application/vnd.github.mockingbird-preview+json"`, { encoding: 'utf-8' });
    const events = JSON.parse(timelineJson);

    let dismissalTime = null;

    for (const event of events) {
      // 1. An approval was dismissed (usually by a new push)
      if (event.event === 'review_dismissed') {
        dismissalTime = new Date(event.created_at).getTime();
      }
      
      // 2. A new approval was submitted
      if (event.event === 'reviewed' && event.state === 'approved' && dismissalTime) {
        const reApprovalTime = new Date(event.submitted_at).getTime();
        const wastedMs = reApprovalTime - dismissalTime;
        
        // Only count if it makes chronological sense
        if (wastedMs > 0) {
          const wastedHours = (wastedMs / (1000 * 60 * 60)).toFixed(2);
          console.log(`🚨 PR #${pr.number} blocked for ${wastedHours} hours waiting for re-approval.`);
          
          totalWastedMs += wastedMs;
          reApprovalCount++;
        }
        // Reset so we don't double count
        dismissalTime = null; 
      }
    }
  }

  const totalWastedHours = (totalWastedMs / (1000 * 60 * 60)).toFixed(2);
  const averageWastedHours = reApprovalCount > 0 ? (totalWastedHours / reApprovalCount).toFixed(2) : 0;

  console.log(`\n=================================================`);
  console.log(`📊 UNDENIABLE PROOF METRICS (${prs.length} PRs analyzed)`);
  console.log(`=================================================`);
  console.log(`Total unnecessary re-approvals: ${reApprovalCount}`);
  console.log(`Total wall-clock time wasted:   ${totalWastedHours} hours`);
  console.log(`Average delay per trivial push: ${averageWastedHours} hours`);
  console.log(`=================================================\n`);
  
} catch (error) {
  console.error("Error fetching data. Make sure the GitHub CLI (gh) is installed and authenticated.");
  console.error(error.message);
}

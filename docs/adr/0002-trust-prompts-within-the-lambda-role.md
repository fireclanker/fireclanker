# Trust prompts within the agent microVM execution role

The MVP accepts trusted prompts and gives unattended OpenCode its normal shell, filesystem, and network tools under a least-privileged agent microVM execution role. Lambda's Firecracker microVM isolates compute from the host but does not isolate agent tools from that role, so orchestration credentials such as the queue worker's GitHub App access belong to a separate role and hostile-prompt protection from resources granted to the agent role is explicitly outside the MVP.

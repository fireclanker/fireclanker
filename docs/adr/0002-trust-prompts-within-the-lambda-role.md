# Trust prompts within the Lambda role

The MVP accepts trusted prompts and gives unattended OpenCode its normal shell, filesystem, and network tools under a least-privileged worker role. Lambda's Firecracker microVM isolates compute from the host but does not isolate agent tools from the Lambda execution role, so hostile-prompt protection from deployment AWS resources requires a different credential boundary and is explicitly outside the MVP.

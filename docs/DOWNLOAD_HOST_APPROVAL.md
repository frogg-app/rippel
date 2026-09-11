# Model download hosts

The agent's built-in source and redirect hosts are in `apps/agent/go/models.go` (`allowedModelURL`). Initially these are Hugging Face and Civitai, plus explicitly named Hugging Face delivery hosts.

From agent 0.3.1, an unrecognized public HTTPS redirect pauses the download. Models opens an approval dialog naming that exact host. An administrator may approve, deny, or choose Later. Later leaves the download paused with a Review host button. Approval expires after 15 minutes; retry requests a fresh download if it expires.

Approval is saved per machine under `approvedModelHosts` in the agent home's `config.json` (normally `~/.rippel-agent/config.json`). It trusts the exact hostname for future model download redirects, without wildcard or parent-domain approval. Denial fails the download. Built-in hosts remain compiled into the agent; custom approvals are not currently editable from Settings.

The authenticated approval endpoint accepts only the host pending on the named task. Approval does not permit insecure URLs, credentials, custom ports, private network addresses, or checksum bypasses. DNS addresses are validated and pinned when connecting. Signed delivery URLs are omitted from download errors.

The API journals pending approval with the install, so reloading Models restores it. An agent restart loses its in-memory task; the API fails tracking rather than silently replaying a download.

# Security policy

## Supported versions

Security fixes are provided for the latest 1.x release. Upgrade to the newest
patch before reporting behavior that may already be corrected.

## Reporting a vulnerability

Do not open a public issue with exploit details or affected application data.
Use **Report a vulnerability** in the repository's Security tab. Include the
affected version, minimal reproduction, impact, and any suggested mitigation.

You should receive an acknowledgement within seven days. A validated report
will be coordinated privately until a fix and release notes are ready.

## Security boundary

`mermaid-spec` validates declared data and transition contracts. It does not
authenticate users, decide authorization, store application secrets, execute
database migrations, or make an application secure by itself. Applications
must enforce those controls and review generated artifacts before deployment.

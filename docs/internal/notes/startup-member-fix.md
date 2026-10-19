# Startup member recovery • Vanguard 2.9.7

Error 10007 means Discord confirmed that the member could not be found in the guild. Startup previously fetched every active quarantine backup without handling that case, so a departed member could stop the entire bot before command sync and the online banner.

Startup now skips only confirmed Unknown Member (10007) responses and continues with remaining saved members. Quarantine records and saved roles are retained, not deleted or deactivated. A retained quarantine is reconciled on a future member join or later startup. A departure during the reconciliation lookup is handled the same way.

Network failures, missing permissions, Unknown Guild and revoked authorization are not treated as member absence. They continue to surface as errors rather than silently declaring protection ready. The patch does not remove or alter existing quarantine records.

The image dependency is pinned to sharp 0.35.5 to resolve the advisories reported against 0.34.5. SVG decoding is also explicitly blocked because scam matching supports only PNG/JPEG/WebP. The updater runs npm ci using the revised lockfile, rather than a blanket audit fix. Native prebuilt packages are installed for the user's platform; preserve npm's install-script policy.

Stop the bot, run Update-Vanguard-Scam-Protection.ps1 from the existing project folder, then npm start. Existing settings, credentials and databases are preserved. The patch is cumulative for Vanguard 2.9.0 through 2.9.7. It backs up changed project files and verifies compiled modules. Native Windows execution and live Discord startup with your actual saved member records remain untested here.

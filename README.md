<div align="center">

  <img src="assets/bizora-logo.png" alt="Bizora" width="110" />

  <h1>Bizora</h1>

  <p><strong>Business Made Simpler.</strong></p>

  <p>A Windows desktop app for managing clients, quotations, invoices, payments, and business assets.</p>

  <p>
    <img src="https://img.shields.io/badge/Platform-Windows-0078D4" alt="Windows" />
    <img src="https://img.shields.io/badge/React-19-61DAFB" alt="React" />
    <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript" />
    <img src="https://img.shields.io/badge/Tauri-2-FFC131" alt="Tauri 2" />
    <img src="https://img.shields.io/badge/Storage-SQLite-003B57" alt="SQLite" />
  </p>

</div>

## Preview

<div align="center">
  <img src="assets/dashboard.png" alt="Bizora dashboard" width="900" />
</div>

## Features

- Dashboard overview
- Client management
- Quotation creation and PDF export
- Invoice creation and PDF export
- Payment tracking
- Business asset records
- Local SQLite data storage

## Download

Windows installers are available from [GitHub Releases](https://github.com/josephamwaalwa/bizora-ai-studio-staging/releases).

## Built with

React · TypeScript · Vite · Tailwind CSS · Tauri 2 · Rust · SQLite

## Development

**Prerequisites:** Node.js, npm, Rust, and the Windows prerequisites for Tauri.

```bash
git clone https://github.com/josephamwaalwa/bizora-ai-studio-staging.git
cd bizora-ai-studio-staging
npm install
npm run tauri:dev
```

Build the Windows app:

```bash
npm run tauri:build
```

## Storage & Authentication

Bizora stores business records locally in SQLite. Sign-in is provided through Supabase (email/password and Google). Business-data cloud sync is not currently available.

---

<div align="center">
  <sub>Bizora — Business Made Simpler.</sub>
</div>

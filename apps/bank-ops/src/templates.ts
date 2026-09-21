import type { Member } from './data/members.js';

const LAYOUT_HEAD = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bank Operations Console</title>
  <style>
    body {
      font-family: 'Courier New', Courier, monospace;
      background-color: #d4d0c8;
      color: #000;
      margin: 0;
      padding: 0;
    }
    .app-header {
      background-color: #000080;
      color: #fff;
      padding: 8px 16px;
      font-size: 14px;
      font-weight: bold;
      letter-spacing: 1px;
    }
    .content {
      padding: 20px;
      max-width: 800px;
    }
    .section-title {
      font-size: 13px;
      font-weight: bold;
      border-bottom: 1px solid #808080;
      padding-bottom: 4px;
      margin-bottom: 12px;
      color: #000080;
    }
    input[type="text"] {
      font-family: 'Courier New', Courier, monospace;
      font-size: 13px;
      padding: 3px 6px;
      border: 2px inset #808080;
      background: #fff;
    }
    button {
      font-family: 'Courier New', Courier, monospace;
      font-size: 12px;
      padding: 4px 16px;
      cursor: pointer;
      background: #d4d0c8;
      border: 2px outset #d4d0c8;
    }
    button:active {
      border-style: inset;
    }
    a {
      color: #000080;
    }
    table {
      border-collapse: collapse;
      font-size: 13px;
      width: 100%;
    }
    th {
      text-align: left;
      background: #808080;
      color: #fff;
      padding: 4px 8px;
      font-weight: normal;
    }
    td {
      padding: 4px 8px;
      border-bottom: 1px solid #c0c0c0;
    }
    .error-msg {
      color: #cc0000;
      font-weight: bold;
      font-size: 13px;
      padding: 8px;
      border: 1px solid #cc0000;
      background: #ffe0e0;
      margin: 8px 0;
    }
    .info-row {
      margin: 4px 0;
      font-size: 13px;
    }
    .info-label {
      display: inline-block;
      width: 120px;
      font-weight: bold;
    }
    .nav-link {
      font-size: 12px;
      margin-top: 16px;
    }
    .status-active { color: #008000; }
    .status-inactive { color: #808080; }
    .status-suspended { color: #cc0000; }
  </style>
</head>
<body>
  <div class="app-header">BANK OPERATIONS CONSOLE</div>
  <div class="content">
`;

const LAYOUT_FOOT = `
  </div>
</body>
</html>
`;

function wrap(body: string): string {
  return LAYOUT_HEAD + body + LAYOUT_FOOT;
}

export function renderSearchPage(error?: string): string {
  let errorHtml = '';
  if (error) {
    errorHtml = `<div class="error-msg">${escapeHtml(error)}</div>`;
  }
  return wrap(`
    <div class="section-title">MEMBER SEARCH</div>
    ${errorHtml}
    <form method="GET" action="/member">
      <label>Member ID:
        <input type="text" name="id" maxlength="10" size="12">
      </label>
      <button type="submit">SEARCH</button>
    </form>
  `);
}

export function renderMemberNotFound(memberId: string): string {
  return wrap(`
    <div class="section-title">MEMBER SEARCH</div>
    <div class="error-msg">No member found with ID: ${escapeHtml(memberId)}</div>
    <div class="nav-link"><a href="/">&larr; Back to Search</a></div>
  `);
}

export function renderMemberPage(member: Member): string {
  const statusClass = `status-${member.status.toLowerCase()}`;
  return wrap(`
    <div class="section-title">MEMBER INFORMATION</div>
    <div class="info-row"><span class="info-label">Member ID:</span> ${escapeHtml(member.memberId)}</div>
    <div class="info-row"><span class="info-label">Name:</span> ${escapeHtml(member.name)}</div>
    <div class="info-row"><span class="info-label">Status:</span> <span class="${statusClass}">${escapeHtml(member.status)}</span></div>
    <div class="info-row"><span class="info-label">Phone:</span> ${escapeHtml(member.phone)}</div>
    <div class="info-row"><span class="info-label">Email:</span> ${escapeHtml(member.email)}</div>
    <div class="info-row"><span class="info-label">Member Since:</span> ${escapeHtml(member.joinDate)}</div>
    <div style="margin-top: 16px;">
      <a href="/member/${escapeHtml(member.memberId)}/accounts">[ View Accounts ]</a>
    </div>
    <div style="margin-top: 20px; padding: 12px; border: 1px dashed #808080;">
      <div style="font-weight: bold; margin-bottom: 8px; color: #800000;">SECURITY &amp; ACCESS</div>
      <form method="POST" action="/member/${escapeHtml(member.memberId)}/reset-access">
        <button type="submit" id="btn-reset-access" style="background: #d4d0c8; color: #800000; font-weight: bold; border: 2px outset #808080;">
          [ Reset Web Access Password ]
        </button>
      </form>
    </div>
    <div class="nav-link"><a href="/">&larr; Back to Search</a></div>
  `);
}

export function renderResetAccessConfirmationPage(member: Member): string {
  return wrap(`
    <div class="section-title">SECURITY &mdash; WEB ACCESS RESET</div>
    <div class="info-msg" id="reset-success-banner" style="color: #006000; font-weight: bold; padding: 8px; border: 1px solid #008000; background: #e8ffe8; margin: 8px 0;">
      TEMPORARY ACCESS CODE GENERATED FOR ${escapeHtml(member.name)}: TEST-RESET-9999
    </div>
    <div class="info-row"><span class="info-label">Member ID:</span> ${escapeHtml(member.memberId)}</div>
    <div class="info-row"><span class="info-label">Status:</span> Temporary Access Code Active</div>
    <div class="nav-link"><a href="/member?id=${escapeHtml(member.memberId)}">&larr; Back to Member</a></div>
  `);
}

export function renderAccountsPage(member: Member): string {
  const rows = member.accounts.map(a => `
    <tr>
      <td>${escapeHtml(a.type)}</td>
      <td>${escapeHtml(a.maskedNumber)}</td>
      <td style="text-align: right;">$${a.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
    </tr>
  `).join('');

  return wrap(`
    <div class="section-title">ACCOUNTS &mdash; MEMBER ${escapeHtml(member.memberId)} (${escapeHtml(member.name)})</div>
    <table>
      <tr>
        <th>ACCOUNT TYPE</th>
        <th>ACCOUNT NUMBER</th>
        <th style="text-align: right;">BALANCE</th>
      </tr>
      ${rows}
    </table>
    <div class="nav-link"><a href="/member?id=${escapeHtml(member.memberId)}">&larr; Back to Member</a> | <a href="/">&larr; Search</a></div>
  `);
}

export function renderValidationError(message: string): string {
  return wrap(`
    <div class="section-title">MEMBER SEARCH</div>
    <div class="error-msg">VALIDATION ERROR: ${escapeHtml(message)}</div>
    <div class="nav-link"><a href="/">&larr; Back to Search</a></div>
  `);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

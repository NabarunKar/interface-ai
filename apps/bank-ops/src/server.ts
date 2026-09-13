import express from 'express';
import { findMember, isValidMemberId } from './data/members.js';
import {
  renderSearchPage,
  renderMemberPage,
  renderAccountsPage,
  renderMemberNotFound,
  renderValidationError,
} from './templates.js';

export function createApp(): express.Express {
  const app = express();

  // Home / search page
  app.get('/', (_req, res) => {
    res.type('html').send(renderSearchPage());
  });

  // Member lookup
  app.get('/member', (req, res) => {
    const id = (req.query.id as string || '').trim();

    if (!id) {
      res.type('html').send(renderSearchPage('Please enter a Member ID.'));
      return;
    }

    if (!isValidMemberId(id)) {
      res.status(400).type('html').send(
        renderValidationError(`Invalid Member ID format: "${id}". Member ID must be exactly 5 digits.`)
      );
      return;
    }

    const member = findMember(id);
    if (!member) {
      res.status(404).type('html').send(renderMemberNotFound(id));
      return;
    }

    res.type('html').send(renderMemberPage(member));
  });

  // Member accounts
  app.get('/member/:id/accounts', (req, res) => {
    const id = req.params.id;

    if (!isValidMemberId(id)) {
      res.status(400).type('html').send(
        renderValidationError(`Invalid Member ID format: "${id}".`)
      );
      return;
    }

    const member = findMember(id);
    if (!member) {
      res.status(404).type('html').send(renderMemberNotFound(id));
      return;
    }

    res.type('html').send(renderAccountsPage(member));
  });

  return app;
}

// Start server when run directly
const isDirectRun = process.argv[1] && (import.meta.url.endsWith(process.argv[1]) || process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'));

if (isDirectRun) {
  const port = parseInt(process.env.PORT || '3100', 10);
  const app = createApp();
  app.listen(port, () => {
    console.log(`Bank Operations Console running at http://localhost:${port}`);
  });
}

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { createApp } from '../apps/bank-ops/src/server.js';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://localhost:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('Bank Ops - Target Application', () => {
  it('should serve the search page at /', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('BANK OPERATIONS CONSOLE');
    expect(html).toContain('MEMBER SEARCH');
    expect(html).toContain('Member ID:');
  });

  it('should find a valid member (10234)', async () => {
    const res = await fetch(`${baseUrl}/member?id=10234`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('MEMBER INFORMATION');
    expect(html).toContain('Jane Doe');
    expect(html).toContain('10234');
    expect(html).toContain('Active');
  });

  it('should find a second valid member (10235)', async () => {
    const res = await fetch(`${baseUrl}/member?id=10235`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Robert Smith');
  });

  it('should return member-not-found for valid format but nonexistent member (99999)', async () => {
    const res = await fetch(`${baseUrl}/member?id=99999`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('No member found with ID: 99999');
  });

  it('should return validation error for invalid member ID format', async () => {
    const res = await fetch(`${baseUrl}/member?id=abc`);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('VALIDATION ERROR');
    expect(html).toContain('Invalid Member ID format');
  });

  it('should return validation error for too-short member ID', async () => {
    const res = await fetch(`${baseUrl}/member?id=123`);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('VALIDATION ERROR');
  });

  it('should return validation error for too-long member ID', async () => {
    const res = await fetch(`${baseUrl}/member?id=1234567`);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('VALIDATION ERROR');
  });

  it('should prompt when no member ID is provided', async () => {
    const res = await fetch(`${baseUrl}/member`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Please enter a Member ID');
  });

  it('should display accounts for a valid member', async () => {
    const res = await fetch(`${baseUrl}/member/10234/accounts`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('ACCOUNTS');
    expect(html).toContain('Checking');
    expect(html).toContain('Savings');
    expect(html).toContain('****1234');
    expect(html).toContain('****5678');
    // Check balance values are present
    expect(html).toContain('2,481.32');
    expect(html).toContain('8,920.14');
  });

  it('should return not-found for accounts of nonexistent member', async () => {
    const res = await fetch(`${baseUrl}/member/99999/accounts`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('No member found with ID: 99999');
  });

  it('should return validation error for invalid format in accounts route', async () => {
    const res = await fetch(`${baseUrl}/member/abc/accounts`);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('VALIDATION ERROR');
  });
});

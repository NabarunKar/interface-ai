import type { Surface } from '../surface/types.js';
import type { ModelDecision } from './types.js';

/**
 * Result of independent DONE verification.
 *
 * The model claiming DONE ≠ system assumes success.
 * This verifier checks actual application state.
 */
export interface VerificationResult {
  verified: boolean;
  reason: string;
  outputs?: Record<string, unknown>;
}

/**
 * Independent verifier for model DONE claims.
 *
 * After the model returns DONE, this checks the actual
 * surface state to confirm the goal was genuinely achieved.
 */
export interface GoalVerifier {
  verify(surface: Surface, decision: ModelDecision): Promise<VerificationResult>;
}

/**
 * Verifier for the member savings balance lookup workflow.
 *
 * Checks:
 * 1. Current URL contains /accounts
 * 2. Page text contains "Savings"
 * 3. A dollar amount is visible next to Savings
 * 4. The extracted balance is reasonable
 */
export class MemberBalanceVerifier implements GoalVerifier {
  async verify(surface: Surface, decision: ModelDecision): Promise<VerificationResult> {
    try {
      const url = await surface.currentUrl();
      const pageText = await surface.pageText();

      // Check 1: Are we on an accounts page?
      const onAccountsPage = url.includes('/accounts') || pageText.includes('ACCOUNTS');
      if (!onAccountsPage) {
        return {
          verified: false,
          reason: `Not on accounts page. URL: ${url}`,
        };
      }

      // Check 2: Does the page contain "Savings"?
      if (!pageText.includes('Savings')) {
        return {
          verified: false,
          reason: 'Page does not contain "Savings" text',
        };
      }

      // Check 3: Extract a dollar amount from the page near "Savings"
      const balanceMatch = pageText.match(/Savings[\s\S]*?\$[\d,]+\.\d{2}/);
      if (!balanceMatch) {
        return {
          verified: false,
          reason: 'Could not find a dollar amount near "Savings"',
        };
      }

      // Extract the actual balance value
      const amountMatch = balanceMatch[0].match(/\$([\d,]+\.\d{2})/);
      const extractedBalance = amountMatch ? amountMatch[0] : undefined;

      // Check 4: Compare with model's claimed output if provided
      const modelOutputs = decision.type === 'DONE' ? decision.outputs : undefined;
      const modelBalance = modelOutputs?.savingsBalance as string | undefined;

      return {
        verified: true,
        reason: `Savings balance verified on accounts page: ${extractedBalance}`,
        outputs: {
          savingsBalance: extractedBalance,
          ...(modelBalance && modelBalance !== extractedBalance
            ? { modelClaimed: modelBalance }
            : {}),
        },
      };
    } catch (error) {
      return {
        verified: false,
        reason: `Verification failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

/**
 * A no-op verifier that trusts the model's DONE claim.
 * Used only in tests where independent verification is not needed.
 */
export class TrustingVerifier implements GoalVerifier {
  async verify(_surface: Surface, decision: ModelDecision): Promise<VerificationResult> {
    return {
      verified: true,
      reason: 'Trusting verifier — no independent check',
      outputs: decision.type === 'DONE' ? decision.outputs as Record<string, unknown> : undefined,
    };
  }
}

/**
 * A verifier that always fails. Used in tests to verify
 * that DONE + failed verification → failed result.
 */
export class FailingVerifier implements GoalVerifier {
  constructor(private readonly failReason = 'Verification intentionally failed') {}

  async verify(_surface: Surface, _decision: ModelDecision): Promise<VerificationResult> {
    return {
      verified: false,
      reason: this.failReason,
    };
  }
}

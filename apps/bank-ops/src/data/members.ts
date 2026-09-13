export interface MemberAccount {
  type: string;
  accountNumber: string;
  maskedNumber: string;
  balance: number;
}

export interface Member {
  memberId: string;
  name: string;
  status: 'Active' | 'Inactive' | 'Suspended';
  phone: string;
  email: string;
  joinDate: string;
  accounts: MemberAccount[];
}

export const MEMBERS: Record<string, Member> = {
  '10234': {
    memberId: '10234',
    name: 'Jane Doe',
    status: 'Active',
    phone: '(555) 012-3456',
    email: 'jdoe@example.com',
    joinDate: '2018-03-15',
    accounts: [
      {
        type: 'Checking',
        accountNumber: '00041234',
        maskedNumber: '****1234',
        balance: 2481.32,
      },
      {
        type: 'Savings',
        accountNumber: '00055678',
        maskedNumber: '****5678',
        balance: 8920.14,
      },
    ],
  },
  '10235': {
    memberId: '10235',
    name: 'Robert Smith',
    status: 'Active',
    phone: '(555) 098-7654',
    email: 'rsmith@example.com',
    joinDate: '2020-11-02',
    accounts: [
      {
        type: 'Checking',
        accountNumber: '00049876',
        maskedNumber: '****9876',
        balance: 512.07,
      },
      {
        type: 'Savings',
        accountNumber: '00053210',
        maskedNumber: '****3210',
        balance: 15340.89,
      },
      {
        type: 'Money Market',
        accountNumber: '00067777',
        maskedNumber: '****7777',
        balance: 42100.00,
      },
    ],
  },
  '10236': {
    memberId: '10236',
    name: 'Maria Garcia',
    status: 'Inactive',
    phone: '(555) 555-0199',
    email: 'mgarcia@example.com',
    joinDate: '2015-07-20',
    accounts: [
      {
        type: 'Savings',
        accountNumber: '00058888',
        maskedNumber: '****8888',
        balance: 0.00,
      },
    ],
  },
};

/**
 * Validates that a member ID is in the expected format.
 * Member IDs must be 5 digits.
 */
export function isValidMemberId(id: string): boolean {
  return /^\d{5}$/.test(id);
}

export function findMember(id: string): Member | undefined {
  return MEMBERS[id];
}

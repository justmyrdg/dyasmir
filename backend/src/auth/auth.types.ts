export type Role = 'teacher' | 'student';

export interface AuthUser {
  id: number;
  role: Role;
  name: string;
  srCode: string | null;
  email: string | null;
  sectionId: number | null;
  sectionName: string | null;
  /** Still using a password the teacher gave them: only /api/account works until they choose their own. */
  mustChangePassword: boolean;
}

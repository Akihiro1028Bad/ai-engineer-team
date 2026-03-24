import { z } from 'zod';

export const inputSchema = z.object({
  workspaceRoot: z.string().optional().describe('Path to workspace root directory'),
  name: z.string().optional().describe('Explicit reviewer name'),
  email: z.string().email().optional().describe('Explicit reviewer email')
});

export const outputSchema = z.object({
  reviewer: z.string().describe('Formatted reviewer string (e.g., "Name <email>")'),
  name: z.string().optional().describe('Resolved reviewer name'),
  email: z.string().optional().describe('Resolved reviewer email'),
  sources: z.array(z.string()).describe('Sources used to resolve reviewer info'),
  suggestions: z.array(z.string()).describe('Suggestions if reviewer is unknown')
});

export type Input = z.infer<typeof inputSchema>;
export type Output = z.infer<typeof outputSchema>;

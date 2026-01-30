import Anthropic from '@anthropic-ai/sdk';

export interface ArtSubmission {
  id: string;
  imageUrl: string;
  title: string;
  playerAddress: string;
  timestamp: number;
}

export interface JudgeScore {
  submissionId: string;
  creativity: number;      // 1-10
  technical: number;       // 1-10
  aesthetic: number;       // 1-10
  total: number;           // Sum of above
  feedback: string;
}

export interface JudgeResult {
  scores: JudgeScore[];
  winnerId: string;
  winnerScore: number;
  judgedAt: number;
}

const JUDGE_SYSTEM_PROMPT = `You are an expert AI art judge for AI Art Arena, a daily competition where artists submit AI-generated artwork.

Your role is to evaluate each submission based on three criteria:
1. CREATIVITY (1-10): Originality, uniqueness, innovative use of AI tools
2. TECHNICAL (1-10): Quality of execution, proper use of composition, detail
3. AESTHETIC (1-10): Visual appeal, color harmony, emotional impact

Be fair, consistent, and constructive. Provide brief feedback (1-2 sentences) for each piece.

IMPORTANT: Your scores should be decisive. Avoid ties when possible. The highest total score wins.`;

const JUDGE_USER_PROMPT = (submissions: ArtSubmission[]) => `
Please evaluate the following ${submissions.length} AI art submissions for today's competition.

${submissions.map((s, i) => `
## Submission ${i + 1}
- ID: ${s.id}
- Title: "${s.title}"
- Image URL: ${s.imageUrl}
`).join('\n')}

For each submission, provide scores (1-10) for:
- Creativity
- Technical quality
- Aesthetic appeal

Respond in this exact JSON format:
{
  "scores": [
    {
      "submissionId": "id",
      "creativity": 8,
      "technical": 7,
      "aesthetic": 9,
      "feedback": "Brief feedback here"
    }
  ],
  "winnerId": "id of highest scorer",
  "reasoning": "Brief explanation of why this piece won"
}`;

export class AIJudgeService {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async judgeSubmissions(submissions: ArtSubmission[]): Promise<JudgeResult> {
    if (submissions.length === 0) {
      throw new Error('No submissions to judge');
    }

    // Single submission auto-wins
    if (submissions.length === 1) {
      return {
        scores: [{
          submissionId: submissions[0].id,
          creativity: 10,
          technical: 10,
          aesthetic: 10,
          total: 30,
          feedback: 'Solo entry - automatic winner!'
        }],
        winnerId: submissions[0].id,
        winnerScore: 30,
        judgedAt: Date.now()
      };
    }

    const response = await this.client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 2000,
      system: JUDGE_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: JUDGE_USER_PROMPT(submissions)
      }]
    });

    // Extract text content
    const textContent = response.content.find(c => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text response from AI judge');
    }

    // Parse JSON from response
    const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Could not parse judge response');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    
    // Calculate totals and find winner
    const scores: JudgeScore[] = parsed.scores.map((s: any) => ({
      submissionId: s.submissionId,
      creativity: s.creativity,
      technical: s.technical,
      aesthetic: s.aesthetic,
      total: s.creativity + s.technical + s.aesthetic,
      feedback: s.feedback
    }));

    // Sort by total score (descending)
    scores.sort((a, b) => b.total - a.total);

    return {
      scores,
      winnerId: scores[0].submissionId,
      winnerScore: scores[0].total,
      judgedAt: Date.now()
    };
  }

  /**
   * Estimate cost for judging
   * Claude Sonnet: ~$0.003/1K input tokens, ~$0.015/1K output tokens
   */
  estimateCost(submissionCount: number): number {
    const inputTokens = 500 + (submissionCount * 100); // System + per submission
    const outputTokens = 200 + (submissionCount * 50); // Per submission response
    
    const inputCost = (inputTokens / 1000) * 0.003;
    const outputCost = (outputTokens / 1000) * 0.015;
    
    return inputCost + outputCost;
  }
}

export default AIJudgeService;

// Simplified interface for automation
export interface SimpleArtSubmission {
  id: string;
  imageUrl: string;
  title: string;
  artist: string;
}

export interface SimpleScore {
  creativity: number;
  technique: number;
  theme: number;
  reasoning: string;
}

// Simple function for automation to call
export async function judgeArtworks(submissions: SimpleArtSubmission[]): Promise<SimpleScore[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  
  if (!apiKey) {
    console.log('⚠️ No ANTHROPIC_API_KEY - using random scores for demo');
    // Return random scores for demo/testing
    return submissions.map(() => ({
      creativity: Math.floor(Math.random() * 5) + 5,
      technique: Math.floor(Math.random() * 5) + 5,
      theme: Math.floor(Math.random() * 5) + 5,
      reasoning: 'Demo mode - random scoring'
    }));
  }

  const judge = new AIJudgeService(apiKey);
  
  const fullSubmissions: ArtSubmission[] = submissions.map(s => ({
    id: s.id,
    imageUrl: s.imageUrl,
    title: s.title,
    playerAddress: s.artist,
    timestamp: Date.now()
  }));

  const result = await judge.judgeSubmissions(fullSubmissions);

  // Map to simple scores
  return result.scores.map(s => ({
    creativity: s.creativity,
    technique: s.technical,
    theme: s.aesthetic,
    reasoning: s.feedback
  }));
}

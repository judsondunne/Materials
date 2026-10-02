import type { Dataset } from '../src/domain/types.js';
import type { AgentEvent, AgentStep, CardData, ChatRequest, Citation, UsageInfo } from '../src/ai/protocol.js';
import { validateUiAction } from '../src/ai/protocol.js';
import { buildToolContext, runTool, toolDeclarations } from '../src/ai/tools/index.js';
import { AI_CONFIG } from './config.js';
import { cacheable, OpenRouterError, streamWithRetry, type ChatMessage } from './openrouter.js';
import { buildContextMessage, buildSystemPrompt } from './prompt.js';

/**
 * The agent loop.
 *
 * The ordering here is the feature. Within one turn:
 *
 *   model decides tools → tools execute → UI actions stream to the client and
 *   the workspace visibly moves → tool results go back to the model → the model
 *   finally streams prose about what is now on screen.
 *
 * Prose is never emitted before the tools it depends on have resolved, which is
 * why the assistant cannot narrate a conclusion it has not yet been given. A
 * model that opens with text and then asks for a tool has that text discarded
 * from the visible answer and kept only in the history, so a half-formed opinion
 * never reaches the user ahead of the evidence.
 */

export interface RunOptions {
  ds: Dataset;
  request: ChatRequest;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
}

let runCounter = 0;

export async function runAgent({ ds, request, signal, emit }: RunOptions): Promise<void> {
  const runId = `run_${Date.now().toString(36)}_${(runCounter++).toString(36)}`;
  emit({ t: 'run_start', runId });

  const turnDeadline = Date.now() + AI_CONFIG.turnTimeoutMs;
  const tools = toolDeclarations(ds);
  const toolCtx = buildToolContext(ds, request.context);

  const messages: ChatMessage[] = [
    // Marked cacheable: identical on every iteration, and on every turn of the
    // session. The dynamic context below it is deliberately a separate message
    // so it cannot invalidate the cached prefix.
    { role: 'system', content: cacheable(buildSystemPrompt(ds)) },
    { role: 'system', content: `CURRENT APPLICATION STATE\n${buildContextMessage(ds, request.context)}` },
    ...request.messages.slice(-AI_CONFIG.historyTurns).map(
      (m): ChatMessage => ({ role: m.role, content: m.content }),
    ),
  ];

  const usage: UsageInfo = {
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    toolCalls: 0,
    model: AI_CONFIG.model,
  };

  let stepSeq = 0;

  try {
    for (let iteration = 0; iteration < AI_CONFIG.maxIterations; iteration++) {
      if (signal.aborted) {
        emit({ t: 'run_end', runId, status: 'aborted', usage });
        return;
      }
      if (Date.now() > turnDeadline) {
        emit({
          t: 'error',
          message: 'This took too long and was stopped. Try asking for one thing at a time.',
          recoverable: true,
        });
        emit({ t: 'run_end', runId, status: 'error', usage });
        return;
      }

      // Every response is buffered until its tool calls are known. Prose that
      // arrives alongside a tool call is the model thinking aloud on its way to
      // the evidence — it is kept in the history so the model remembers saying
      // it, but it is never shown, because the user would then read a conclusion
      // before the analysis behind it had run. Only a response with no tool
      // calls is the answer, and only that is emitted.
      let buffered = '';
      const result = await streamWithRetry(
        messages,
        tools,
        {
          onText: (text) => {
            buffered += text;
          },
        },
        signal,
      );

      usage.promptTokens += result.usage.promptTokens;
      usage.completionTokens += result.usage.completionTokens;
      usage.cachedTokens += result.usage.cachedTokens ?? 0;
      if (result.usage.cost !== undefined) usage.cost = (usage.cost ?? 0) + result.usage.cost;

      // No tool calls: this is the answer.
      if (result.toolCalls.length === 0) {
        const answer = buffered || result.text;
        if (answer.trim().length > 0) emit({ t: 'delta', text: answer });
        else {
          emit({
            t: 'error',
            message: 'The model returned nothing. Try rephrasing the question.',
            recoverable: true,
          });
        }
        emit({ t: 'run_end', runId, status: 'complete', usage });
        return;
      }

      messages.push({
        role: 'assistant',
        content: buffered.length > 0 ? buffered : null,
        tool_calls: result.toolCalls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments },
        })),
      });

      for (const call of result.toolCalls) {
        if (signal.aborted) {
          emit({ t: 'run_end', runId, status: 'aborted', usage });
          return;
        }
        usage.toolCalls++;

        const stepId = `${runId}_s${stepSeq++}`;
        let parsedArgs: unknown = {};
        let parseError: string | null = null;
        try {
          parsedArgs = call.arguments.trim().length > 0 ? JSON.parse(call.arguments) : {};
        } catch {
          // Malformed JSON from the model is recoverable: hand it back and let
          // the next iteration produce well-formed arguments.
          parseError = `The arguments for ${call.name} were not valid JSON. Send them again as a JSON object.`;
        }

        if (parseError) {
          emit({ t: 'step', step: { id: stepId, tool: call.name, label: `Checking ${call.name}`, status: 'error', error: parseError } });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ ok: false, error: parseError }),
          });
          continue;
        }

        const { runningLabel, result: toolResult, durationMs } = runTool(call.name, parsedArgs, toolCtx);

        // The running step is emitted with the label the tool chose, so the
        // activity trail says "Loading EXP_28" rather than the tool's name.
        emit({ t: 'step', step: { id: stepId, tool: call.name, label: runningLabel, status: 'running' } });

        if (!toolResult.ok) {
          const step: AgentStep = {
            id: stepId,
            tool: call.name,
            label: runningLabel,
            status: 'error',
            ms: durationMs,
            error: toolResult.message,
          };
          emit({ t: 'step', step });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({
              ok: false,
              code: toolResult.code,
              path: toolResult.path,
              error: toolResult.message,
              validValues: toolResult.validValues,
              instruction:
                'Fix the arguments and call the tool again, or tell the user plainly what cannot be answered. Do not invent the result.',
            }),
          });
          continue;
        }

        // The workspace moves here, before the model has said anything about it.
        const applied: string[] = [];
        for (const action of toolResult.ui ?? []) {
          const valid = validateUiAction(action);
          if (!valid) continue;
          emit({ t: 'ui', action: valid });
          applied.push(valid.type);
        }

        const citations: Citation[] = (toolResult.citations ?? []).filter(Boolean);
        if (citations.length > 0) emit({ t: 'evidence', citations });
        for (const card of toolResult.cards ?? []) emit({ t: 'card', card: card as CardData });

        emit({
          t: 'step',
          step: { id: stepId, tool: call.name, label: toolResult.label, status: 'ok', ms: durationMs },
        });

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({
            ok: true,
            ...toolResult.data,
            ...(applied.length > 0
              ? { workspaceChanged: applied, note: 'The application has already moved. Describe it in the past tense.' }
              : {}),
          }),
        });
      }
    }

    // Loop ceiling reached. Ask for a summary of what the tools already found
    // rather than leaving the turn with no answer at all.
    emit({
      t: 'step',
      step: {
        id: `${runId}_limit`,
        tool: 'agent',
        label: `Reached the ${AI_CONFIG.maxIterations}-step limit — summarising`,
        status: 'ok',
      },
    });
    messages.push({
      role: 'user',
      content:
        'You have reached the tool limit for this turn. Answer now using only the tool results above. Do not call another tool. If the question is not fully answered, say which part is outstanding.',
    });
    const final = await streamWithRetry(messages, [], { onText: (text) => emit({ t: 'delta', text }) }, signal);
    usage.promptTokens += final.usage.promptTokens;
    usage.completionTokens += final.usage.completionTokens;
    emit({ t: 'run_end', runId, status: 'complete', usage });
  } catch (err) {
    if (signal.aborted) {
      emit({ t: 'run_end', runId, status: 'aborted', usage });
      return;
    }
    const message =
      err instanceof OpenRouterError
        ? err.message
        : `Something went wrong running that: ${err instanceof Error ? err.message : String(err)}`;
    emit({ t: 'error', message, recoverable: true });
    emit({ t: 'run_end', runId, status: 'error', usage });
  }
}

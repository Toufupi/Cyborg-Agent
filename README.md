# Cyborg-Agent

Cyborg-Agent is an Agent pattern: **half LLM, half code scheduler**.

The core idea is that an Agent should not store all knowledge in prompts. When a method becomes repeatable, the Agent should turn it into code, save it, test it, version it, and call it again later. Prompts remain useful for reasoning and adaptation; code becomes the durable memory of how work is actually done.

## Why This Exists

Large models are creative, but they are not naturally deterministic. The same instruction can produce different outputs. Code gives us the opposite properties: stable execution, reproducible behavior, clear errors, and version history.

Cyborg-Agent combines both:

- LLM for planning, judgment, language, and new task understanding;
- code for reliable execution, validation, transformation, generation, and automation;
- A2C2A for the protocol boundary between the two.

In this model, the Agent becomes a dispatcher of tools it can understand, repair, and extend.

## Architecture

```text
User goal
   |
   v
Cyborg Agent
   |
   +-- decide whether existing code can solve the task
   |
   +-- call tool through A2C2A JSON
   |      |
   |      +-- validate JSON
   |      +-- validate input contract
   |      +-- run script/API/CLI
   |      +-- return result or structured error
   |
   +-- repair input, compose tools, or create new code
   |
   v
Result + reusable code knowledge
```

## Repository Role

This repository will hold the reference Agent implementation and orchestration experiments.

It depends conceptually on:

- `A2C2A`: the protocol used to call deterministic code and receive repairable errors.
- `Page-Generator-CLI`: a concrete tool family where the Agent composes validated page components instead of free-form HTML guesses.

## Expected Capabilities

- register local scripts as callable tools;
- inspect each tool's A2C2A manifest and input contract;
- generate valid JSON calls for tools;
- repair calls using `json_parse_error`, `input_validation_error`, and `runtime_error` responses;
- save newly created scripts as reusable knowledge;
- use version control to evolve scripts when tasks change;
- keep expensive online LLM work focused on new coding and hard reasoning, while local execution handles repeatable workflows.

## Error-Aware Loop

Cyborg-Agent should treat errors as part of the conversation, not as dead ends.

```text
Agent sends JSON -> code validates -> code returns error -> Agent fixes JSON/input/code -> retry
```

The most important distinction:

- `json_parse_error`: the Agent did not send valid JSON.
- `request_format_error`: the Agent did not follow the A2C2A envelope.
- `input_validation_error`: the Agent selected the right action but gave wrong data.
- `runtime_error`: the data passed validation, but the script itself failed or met bad runtime data.

This makes failures useful. They become feedback for the next Agent action.

## Roadmap

- Tool registry for local scripts and CLIs.
- A2C2A manifest discovery.
- Agent planning loop with structured retries.
- Script creation and versioning workflow.
- Local-first execution mode.
- Integration examples with `Page-Generator-CLI`.

## Philosophy

Make Code Great Again does not mean rejecting LLMs. It means letting LLMs do what they are good at while preserving the computer world's strongest invention: executable, inspectable, reusable code.

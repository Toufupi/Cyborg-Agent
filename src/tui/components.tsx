import React from "react";
import { Box, Text } from "ink";
import logSymbols from "log-symbols";
import type { ToolRegistration } from "../types.js";

export function Header({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1} paddingY={0} marginBottom={1}>
      <Text bold color="green">{title}</Text>
      {subtitle ? <Text color="gray">{subtitle}</Text> : null}
    </Box>
  );
}

export function StatusBar({ smallModel, mode }: { smallModel: string; mode: string }) {
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
      <Text color="cyan">small</Text>
      <Text> {smallModel} </Text>
      <Text color="gray">| routing </Text>
      <Text color="yellow">{mode}</Text>
      <Text color="gray"> | q quit</Text>
    </Box>
  );
}

export function ToolList({ tools }: { tools: Array<{ registration: ToolRegistration }> }) {
  return (
    <Box flexDirection="column">
      <Text bold>Registered tools</Text>
      {tools.length === 0 ? <Text color="gray">No tools registered.</Text> : null}
      {tools.map(({ registration }) => (
        <Box key={registration.name} flexDirection="column" marginTop={1}>
          <Text color="green">{logSymbols.success}</Text>
          <Text> {registration.name} <Text color="gray">({registration.runtime?.type ?? "runtime?"})</Text></Text>
          <Text color="gray">  {registration.description ?? ""}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function ToolCallCard({ title, status, stdout, stderr }: { title: string; status: "idle" | "running" | "ok" | "failed"; stdout?: string; stderr?: string }) {
  const color = status === "ok" ? "green" : status === "failed" ? "red" : status === "running" ? "yellow" : "gray";
  const symbol = status === "ok" ? logSymbols.success : status === "failed" ? logSymbols.error : status === "running" ? "…" : "·";
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginTop={1}>
      <Text color={color}>{symbol} {title}</Text>
      {stdout ? <Text>{stdout.trim().slice(0, 1200)}</Text> : null}
      {stderr ? <Text color="red">{stderr.trim().slice(0, 800)}</Text> : null}
    </Box>
  );
}

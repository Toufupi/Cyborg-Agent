import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";

const glyphs = "01";
const idleWord = "CYBORG";

export function MatrixRain({ active, width = 36, rows = 3 }: { active: boolean; width?: number; rows?: number }) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => setTick((value) => value + 2), 35);
    return () => clearInterval(timer);
  }, [active]);

  const lines = useMemo(() => buildLines(width, rows, tick, active), [width, rows, tick, active]);

  return (
    <Box flexDirection="column">
      {lines.map((line, rowIndex) => (
        <Box key={rowIndex}>
          {line.map((cell, index) => (
            <Text key={`${rowIndex}-${index}-${cell.char}`} color={cell.color} bold={cell.bold}>
              {cell.char}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}

function buildLines(width: number, rows: number, tick: number, active: boolean) {
  const wordRow = Math.floor(rows / 2);
  const wordStart = Math.max(0, Math.floor((width - idleWord.length) / 2));
  return Array.from({ length: rows }, (_, rowIndex) => buildCells(width, rowIndex, tick, active, {
    word: active || rowIndex !== wordRow ? "" : idleWord,
    wordStart
  }));
}

function buildCells(
  width: number,
  rowIndex: number,
  tick: number,
  active: boolean,
  idle: { word: string; wordStart: number }
) {
  const head = active ? (tick + rowIndex * 7) % Math.max(1, width) : -1;
  return Array.from({ length: width }, (_, index) => {
    const wordIndex = index - idle.wordStart;
    if (wordIndex >= 0 && wordIndex < idle.word.length) {
      return {
        char: idle.word[wordIndex] ?? "C",
        color: "#00ff41",
        bold: true
      };
    }

    const charIndex = seededBit(index, rowIndex, tick);
    const distance = head < 0 ? 99 : Math.abs(index - head);
    const shimmer = seededBit(index + tick, rowIndex, tick + 11) === 1;
    return {
      char: glyphs[charIndex] ?? "0",
      color: active && distance <= 1 ? "#00ff41" : active && (distance <= 5 || shimmer) ? "#00a83b" : "#005f26",
      bold: distance <= 1
    };
  });
}

function seededBit(index: number, rowIndex: number, tick: number) {
  const value = (index + 1) * 1103515245 + (rowIndex + 3) * 12345 + tick * 2654435761;
  return Math.abs(value >>> 7) % 2;
}

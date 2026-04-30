import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";

const glyphs = "01";
const idleWord = "CYBORG";
const idleBigWord = [
  "1111 1   1 111  111  111  1111",
  "1    1   1 1  1 1  1 1  1 1   ",
  "1     111  111  1  1 111  1 11",
  "1      1   1  1 1  1 1 1  1  1",
  "1111   1   111  111  1  1 1111"
];

type IdleOverlay = {
  variant: "word" | "big-word";
  rowStart: number;
  columnStart: number;
};

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
  const overlay = active ? undefined : buildIdleOverlay(width, rows, tick);
  return Array.from({ length: rows }, (_, rowIndex) => buildCells(width, rowIndex, tick, active, {
    overlay
  }));
}

function buildCells(
  width: number,
  rowIndex: number,
  tick: number,
  active: boolean,
  idle: { overlay?: IdleOverlay }
) {
  const head = active ? (tick + rowIndex * 7) % Math.max(1, width) : -1;
  return Array.from({ length: width }, (_, index) => {
    const overlayChar = idle.overlay ? getIdleOverlayChar(idle.overlay, rowIndex, index) : "";
    if (overlayChar) {
      return {
        char: overlayChar,
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

function buildIdleOverlay(width: number, rows: number, tick: number): IdleOverlay {
  const variant = seededBit(width, rows, tick) === 0 ? "word" : "big-word";
  const overlayWidth = variant === "word" ? idleWord.length : idleBigWord[0]?.length ?? 0;
  const overlayHeight = variant === "word" ? 1 : idleBigWord.length;
  const maxColumn = Math.max(0, width - overlayWidth);
  const maxRow = Math.max(0, rows - overlayHeight);
  return {
    variant,
    rowStart: maxRow === 0 ? Math.floor(maxRow / 2) : Math.abs((tick + rows * 3) % (maxRow + 1)),
    columnStart: maxColumn === 0 ? Math.floor(maxColumn / 2) : Math.abs((tick * 3 + width) % (maxColumn + 1))
  };
}

function getIdleOverlayChar(overlay: IdleOverlay, rowIndex: number, columnIndex: number) {
  if (overlay.variant === "word") {
    if (rowIndex !== overlay.rowStart) {
      return "";
    }
    const wordIndex = columnIndex - overlay.columnStart;
    return wordIndex >= 0 && wordIndex < idleWord.length ? idleWord[wordIndex] ?? "" : "";
  }

  const wordRow = rowIndex - overlay.rowStart;
  const wordColumn = columnIndex - overlay.columnStart;
  const line = idleBigWord[wordRow];
  if (!line || wordColumn < 0 || wordColumn >= line.length) {
    return "";
  }
  return line[wordColumn] === " " ? "" : line[wordColumn] ?? "";
}

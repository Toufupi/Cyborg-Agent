import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";

const glyphs = "A2C2A01{}[]<>/\\|*-+=CYBORG";

export function MatrixRain({ active, width = 36 }: { active: boolean; width?: number }) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => setTick((value) => value + 1), 90);
    return () => clearInterval(timer);
  }, [active]);

  const cells = useMemo(() => buildCells(width, tick, active), [width, tick, active]);

  return (
    <Box>
      {cells.map((cell, index) => (
        <Text key={`${index}-${cell.char}`} color={cell.color} bold={cell.bold}>
          {cell.char}
        </Text>
      ))}
    </Box>
  );
}

function buildCells(width: number, tick: number, active: boolean) {
  const head = active ? tick % Math.max(1, width) : -1;
  return Array.from({ length: width }, (_, index) => {
    const charIndex = Math.abs((index * 7 + tick * 3) % glyphs.length);
    const distance = head < 0 ? 99 : Math.abs(index - head);
    return {
      char: glyphs[charIndex] ?? "0",
      color: distance === 0 ? "white" : distance <= 2 ? "green" : distance <= 5 ? "greenBright" : "gray",
      bold: distance <= 1
    };
  });
}

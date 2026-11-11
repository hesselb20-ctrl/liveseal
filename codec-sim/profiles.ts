// Seal strength profiles: peak offset per cell in the encoder's 8-bit units,
// for luma and for the two colour-difference planes.
export const PROFILE_STANDARD = { amplitude: 1.5, chroma: 2 } as const;
export const PROFILE_STRONG = { amplitude: 2, chroma: 3 } as const;
export const PROFILES = { standard: PROFILE_STANDARD, strong: PROFILE_STRONG } as const;

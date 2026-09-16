import type { RawDataset } from '../domain/types';

/** A miniature dataset with the same shape as the real one. */
export const tiny: RawDataset = {
  '20200101_EXP_1': {
    inputs: { 'Polymer 1': 60, 'Polymer 2': 0, 'Filler 1': 38, Antioxidant: 2, 'Oven Temperature': 300 },
    outputs: { Strength: 10, Cure: 1.5 },
  },
  '20200102_EXP_2': {
    inputs: { 'Polymer 1': 0, 'Polymer 2': 55, 'Filler 1': 43, Antioxidant: 2, 'Oven Temperature': 350 },
    outputs: { Strength: 14, Cure: 1.8 },
  },
  '20200103_EXP_3': {
    inputs: { 'Polymer 1': 30, 'Polymer 2': 30, 'Filler 1': 38, Antioxidant: 2, 'Oven Temperature': 300 },
    outputs: { Strength: 12, Cure: 1.6 },
  },
  '20200104_EXP_4': {
    inputs: { 'Polymer 1': 50, 'Polymer 2': 10, 'Filler 1': 38, Antioxidant: 2, 'Oven Temperature': 350 },
    outputs: { Strength: 11, Cure: 1.7 },
  },
};

/** Every hostile shape the parser has to survive. */
export const degenerate: RawDataset = {
  ok_row: { inputs: { A: 1, B: 0 }, outputs: { Y: 5 } },
  missing_field: { inputs: { A: 2 }, outputs: { Y: 6 } },
  string_number: { inputs: { A: '3' as unknown as number, B: 1 }, outputs: { Y: 7 } },
  bad_value: { inputs: { A: 'abc' as unknown as number, B: 2 }, outputs: { Y: 8 } },
  null_value: { inputs: { A: null as unknown as number, B: 3 }, outputs: { Y: 9 } },
};

# Data notice

`src/sim/fitted.json` and `src/sim/calibration.json` hold aggregate statistics derived from the databases below. They contain no recording and no single patient's values. Both files are made available under the [Open Database License v1.0](https://opendatacommons.org/licenses/odbl/1-0/).

Contains information from the databases listed here, used under the licences shown. The method is in `scripts/fit-generator.mjs` and `scripts/fit-eicu.mjs`.

| Database | Licence | Citation |
|---|---|---|
| [eICU-CRD Demo 2.0.1](https://physionet.org/content/eicu-crd-demo/2.0.1/) | [ODbL v1.0](https://opendatacommons.org/licenses/odbl/1-0/) | Pollard T, et al. The eICU Collaborative Research Database. Sci Data, 2018. |
| [BIDMC PPG and Respiration 1.0.0](https://physionet.org/content/bidmc/1.0.0/) | [ODC-By v1.0](https://opendatacommons.org/licenses/by/1-0/) | Pimentel MAF, et al. IEEE Trans Biomed Eng, 2017. |
| [MIT-BIH Arrhythmia 1.0.0](https://physionet.org/content/mitdb/1.0.0/) | [ODC-By v1.0](https://opendatacommons.org/licenses/by/1-0/) | Moody GB, Mark RG. IEEE Eng Med Biol, 2001. |
| [MIT-BIH Atrial Fibrillation 1.0.0](https://physionet.org/content/afdb/1.0.0/) | [ODC-By v1.0](https://opendatacommons.org/licenses/by/1-0/) | Moody GB, Mark RG. Computers in Cardiology, 1983. |
| [Long Term AF Database 1.0.0](https://physionet.org/content/ltafdb/1.0.0/) | [ODC-By v1.0](https://opendatacommons.org/licenses/by/1-0/) | Petrutiu S, et al. Europace, 2007. |

All were obtained from PhysioNet: Goldberger AL, et al. Circulation, 2000.

## NEWS2

The NEWS2 scoring tables in `src/sim/news2.ts` are reproduced from: Royal College of Physicians. National Early Warning Score (NEWS) 2: Standardising the assessment of acute-illness severity in the NHS. Updated report of a working party. London: RCP, 2017.

NEWS2 belongs to the RCP and is not covered by this repository's MIT License. The [RCP's NEWS2 page](https://www.rcp.ac.uk/improving-care/resources/national-early-warning-score-news-2/) says there is no copyright restriction on NEWS2, on conditions: acknowledge the RCP with the citation above, do not modify or amend the material, and reproduce the charts in colour from the high-quality downloads. This repository uses the bands and scores unmodified and does not reproduce the charts. The RCP page does not address software. Rounding and abstention are BioSentry's additions around the score, not changes to it.

## Scope

These are mostly ICU, Holter and AF-referred recordings. None is ward data and none is from the Philippines. This notice is not legal advice.

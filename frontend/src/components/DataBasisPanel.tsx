export interface ActivityAnalysis {
  hasActivityData: boolean;
  features: Record<string, number>;
  totals: Record<string, number>;
  housingUnitsPerKm2: number;
  carShare: number;
  externalShare: number;
  zones: number;
  unattachedFeatures: number;
}

const ROWS: [key: string, label: string, unit: string][] = [
  ['housing', 'Dwellings', 'units'],
  ['work', 'Jobs', 'jobs'],
  ['retail', 'Shops / retail', 'attraction'],
  ['education', 'Schools / universities', 'pupils'],
  ['leisure', 'Venues', 'visitors'],
  ['freight', 'Industry / logistics', 'freight units'],
  ['parking', 'Parking', 'spaces'],
];

/** What the generated scenarios are based on (#115): OSM buildings, land use and POIs. */
export function DataBasisPanel({ analysis }: { analysis: ActivityAnalysis }) {
  return (
    <section aria-label="Data basis of the scenarios">
      <h2>Scenario data basis</h2>
      {analysis.hasActivityData ? (
        <>
          <table className="data-basis">
            <tbody>
              {ROWS.filter(([k]) => (analysis.features[k] ?? 0) > 0).map(([k, label, unit]) => (
                <tr key={k}>
                  <th scope="row">{label}</th>
                  <td>{analysis.features[k]} features</td>
                  <td>
                    ≈ {Math.round(analysis.totals[k] ?? 0).toLocaleString('en')} {unit}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            {analysis.zones} zones · car share {Math.round(analysis.carShare * 100)} % · {Math.round(analysis.externalShare * 100)} % of commuters
            cross the area border · {Math.round(analysis.housingUnitsPerKm2).toLocaleString('en')} dwellings/km². Volumes are modelled from OSM
            (no traffic counts) and can be edited per scenario.
          </p>
        </>
      ) : (
        <p className="muted">
          No buildings or points of interest were available for this area; the scenarios use road-class traffic profiles and trips generated along
          residential streets.
        </p>
      )}
    </section>
  );
}

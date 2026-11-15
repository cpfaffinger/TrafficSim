//! Debug snapshots of one vehicle, link (or lane) or junction as JSON (#129): everything the
//! simulation knows about it right now, for bug reports.

use serde_json::{Value, json};

use super::{Simulation, Vehicle};
use crate::network::NONE;

impl Simulation {
    fn connector_id(&self, c: u32) -> Value {
        if c == NONE {
            Value::Null
        } else {
            json!(self.net.connectors[c as usize].id)
        }
    }

    fn vehicle_state(&self, v: &Vehicle) -> Value {
        let net = &self.net;
        let p = &v.params;
        let finite = |x: f64| if x.is_finite() { json!(x) } else { Value::Null };
        json!({
            "id": v.id,
            "segment": if net.is_lane(v.seg) {
                let lane = &net.lanes[v.seg as usize];
                json!({"lane": format!("{}:{}", net.links[lane.link as usize].id, lane.index)})
            } else {
                json!({"connector": self.connector_id(net.segment_connector(v.seg).unwrap_or(NONE))})
            },
            "pos": v.pos,
            "segmentLength": net.seg_length[v.seg as usize],
            "speed": v.speed,
            "acc": v.acc,
            "flags": v.flags,
            "rank": v.rank,
            "nextConnector": self.connector_id(v.next_conn),
            "claimed": self.connector_id(v.claimed),
            "claimedAhead": v.ahead.iter().filter(|&&c| c != NONE).map(|&c| self.connector_id(c)).collect::<Vec<_>>(),
            "stopDistance": finite(v.stop_dist),
            "zoneHold": finite(v.zone_hold),
            "pedestrianHold": finite(v.ped_hold),
            "pedestrianCause": v.ped_cause,
            "waitAtStopLine": v.wait,
            "standingStill": v.still,
            "laneChange": if v.lc_from == NONE { Value::Null } else { json!({"from": v.lc_from, "progress": v.lc_progress}) },
            "lost": v.lost,
            "params": {
                "class": p.class, "vehicleType": p.vehicle_type, "driverProfile": p.driver_profile,
                "length": p.length, "width": p.width, "height": p.height, "weight": p.weight,
                "maxSpeed": p.max_speed, "speedFactor": p.speed_factor, "timeHeadway": p.time_headway,
                "maxAcceleration": p.max_acceleration, "comfortableDeceleration": p.comfortable_deceleration,
                "minimumGap": p.minimum_gap, "reactionTime": p.reaction_time, "politeness": p.politeness,
                "gapAcceptanceFactor": p.gap_acceptance_factor, "familiar": p.familiar,
            },
        })
    }

    /// One vehicle: what the inspector shows plus its internal state, `None` once it left.
    pub fn vehicle_debug(&self, id: u32) -> Option<Value> {
        let v = self.vehicles.iter().find(|v| v.id == id)?;
        Some(json!({
            "kind": "vehicle",
            "time": self.time,
            "info": self.vehicle_info(id),
            "state": self.vehicle_state(v),
        }))
    }

    /// One link with its lanes (or only lane `lane`): vehicles on them, outgoing connectors with
    /// claims and signal states, and the travel times used for routing.
    pub fn link_debug(&self, link_id: &str, lane: Option<u32>) -> Result<Value, String> {
        let net = &self.net;
        let l = net
            .link_index(link_id)
            .ok_or_else(|| format!("unknown link '{link_id}'"))?;
        let info = &net.links[l as usize];
        let lanes: Vec<Value> = (0..info.lane_count)
            .filter(|&k| lane.is_none_or(|x| x == k))
            .map(|k| {
                let seg = info.first_lane + k;
                let vehicles: Vec<Value> = self.seg_vehicles[seg as usize]
                    .iter()
                    .map(|&j| self.vehicle_state(&self.vehicles[j as usize]))
                    .collect();
                let connectors: Vec<Value> = net
                    .lane_outgoing(seg)
                    .iter()
                    .map(|&c| self.connector_debug(c))
                    .collect();
                json!({
                    "index": k,
                    "length": net.seg_length[seg as usize],
                    "speedLimit": net.seg_speed_limit[seg as usize],
                    "classMask": net.lanes[seg as usize].class_mask,
                    "vehicles": vehicles,
                    "connectors": connectors,
                })
            })
            .collect();
        Ok(json!({
            "kind": if lane.is_some() { "lane" } else { "link" },
            "time": self.time,
            "link": {
                "id": info.id, "from": net.nodes[info.from as usize].id, "to": net.nodes[info.to as usize].id,
                "length": info.length, "speedLimit": info.speed_limit, "lanes": info.lane_count,
                "throughTraffic": info.through_traffic, "roundabout": info.roundabout,
                "limits": info.limits.map(|x| if x.is_finite() { json!(x) } else { Value::Null }),
            },
            "travelTime": {
                "freeFlow": self.router.free_flow_time(l),
                "routing": self.router.link_travel_time(l),
                "experienced": self.informed.link_travel_time(l),
            },
            "lanes": lanes,
        }))
    }

    fn connector_debug(&self, c: u32) -> Value {
        let info = &self.net.connectors[c as usize];
        let seg = self.net.connector_segment(c);
        json!({
            "id": info.id,
            "toLink": self.net.links[info.to_link as usize].id,
            "toLane": self.net.lanes[info.to_lane as usize].index,
            "priority": format!("{:?}", info.priority),
            "signal": (info.signal_group != NONE).then(|| json!({
                "group": self.net.signals.groups[info.signal_group as usize].id,
                "state": format!("{:?}", self.signal_state.get(info.signal_group as usize)),
            })),
            "claims": self.conn_claims[c as usize],
            "lastClaim": if self.conn_last_claim[c as usize].is_finite() { json!(self.conn_last_claim[c as usize]) } else { Value::Null },
            "conflicts": self.net.conflicts(c).iter().map(|&k| self.connector_id(k)).collect::<Vec<_>>(),
            "vehicles": self.seg_vehicles[seg as usize].iter().map(|&j| self.vehicles[j as usize].id).collect::<Vec<_>>(),
        })
    }

    /// One junction: its movements with claims, conflicts and signal states, and the vehicles on them.
    pub fn node_debug(&self, node_id: &str) -> Result<Value, String> {
        let net = &self.net;
        let n = net
            .node_index(node_id)
            .ok_or_else(|| format!("unknown node '{node_id}'"))?;
        let connectors: Vec<Value> = (0..net.connectors.len() as u32)
            .filter(|&c| net.connectors[c as usize].node == n)
            .map(|c| {
                let mut v = self.connector_debug(c);
                v["fromLink"] = json!(net.links[net.connectors[c as usize].from_link as usize].id);
                v["fromLane"] = json!(net.lanes[net.connectors[c as usize].from_lane as usize].index);
                v
            })
            .collect();
        let waiting: Vec<Value> = self
            .vehicles
            .iter()
            .filter(|v| {
                v.next_conn != NONE && net.connectors[v.next_conn as usize].node == n && v.speed < 0.5
            })
            .map(|v| self.vehicle_state(v))
            .collect();
        Ok(json!({
            "kind": "node",
            "time": self.time,
            "node": {"id": net.nodes[n as usize].id, "control": format!("{:?}", net.nodes[n as usize].control)},
            "connectors": connectors,
            "waitingVehicles": waiting,
        }))
    }
}

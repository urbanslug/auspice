import React from "react";
import { connect } from "react-redux";
import { withTranslation } from "react-i18next";
import { select } from "d3-selection";
import { interpolateNumber } from "d3-interpolate";
import ErrorBoundary from "../../util/errorBoundry";
import Legend from "../tree/legend/legend";
import Card from "../framework/card";
import { getVisibleNodesPerLocation, createOrUpdateArcs } from "../map/mapHelpersLatLong";
import { getAverageColorFromNodes } from "../../util/colorHelpers";
import { drawDemesAndTransmissions } from "../map/mapHelpers";
import { getTraitFromNode } from "../../util/treeMiscHelpers";
import { bezier } from "../map/transmissionBezier";
import { NODE_NOT_VISIBLE } from "../../util/globals";

/**
 * This is a prototype.
 * There are numerous calls into functions and use of data structures designed
 * for the <Map> component. These are unnecessarily complex for this use case,
 * but are employed to simplify the creation of a prototype without needing
 * to refactor shared functions or duplicate code.
 */

@connect((state) => {
  return {
    branchLengthsToDisplay: state.controls.branchLengthsToDisplay,
    absoluteDateMin: state.controls.absoluteDateMin,
    absoluteDateMax: state.controls.absoluteDateMax,
    nodes: state.tree.nodes,
    nodeColors: state.tree.nodeColors,
    visibility: state.tree.visibility,
    metadata: state.metadata,
    geoResolution: state.controls.geoResolution,
    dateMinNumeric: state.controls.dateMinNumeric,
    dateMaxNumeric: state.controls.dateMaxNumeric,
    colorBy: state.controls.colorScale.colorBy,
    pieChart: (
      !state.controls.colorScale.continuous &&                           // continuous color scale = no pie chart
      state.controls.geoResolution !== state.controls.colorScale.colorBy // geo circles match colorby == no pie chart
    ),
    legendValues: state.controls.colorScale.legendValues,
    showTransmissionLines: state.controls.showTransmissionLines
  };
})
class States extends React.Component {
  constructor(props) {
    super(props);
    this.svgDomRef = null;
  }
  redraw(props) {
    // prototype. Recreate data every update & redraw.
    const {demeData, demeIndices, transmissionData, transmissionIndices} = setUpDataStructures(props); // eslint-disable-line
    // console.log("redraw()");
    // console.log("demeData", demeData);
    // console.log("demeIndices", demeIndices);
    // console.log("transmissionData", transmissionData);
    // console.log("transmissionIndices", transmissionIndices);
    renderDemes({svgDomRef: this.svgDomRef, demeData, transmissionData, ...props});
  }
  componentDidMount() {
    // console.log("\n\n----------CDM-------------");
    this.redraw(this.props);
  }
  componentWillReceiveProps(nextProps) {
    // console.log("\n\n----------CWRP-------------");
    this.redraw(nextProps);
  }

  render() {
    const { t } = this.props;
    return (
      <Card center title={t("Node States")}>
        {this.props.legend && (
          <ErrorBoundary>
            <Legend right width={this.props.width} />
          </ErrorBoundary>
        )}
        <svg
          id="NodeStatesGraph"
          style={{pointerEvents: "auto", cursor: "default", userSelect: "none"}}
          width={this.props.width}
          height={this.props.height}
          ref={(c) => {this.svgDomRef = c;}}
        />
      </Card>
    );
  }

}

function setUpDataStructures(props) {
  const locationToVisibleNodes = getVisibleNodesPerLocation(props.nodes, props.visibility, props.geoResolution);
  const demeData = [];
  const demeIndices = []; // not useful since we never use triplicate for <States>

  const getCoord = coordFactory(props.width, props.height, Object.keys(locationToVisibleNodes).length);

  Object.entries(locationToVisibleNodes).forEach(([location, visibleNodes], index) => {
    const deme = {
      name: location,
      count: visibleNodes.length,
      coords: getCoord(index)
    };
    if (props.pieChart) {
      /* create the arcs for the pie chart. NB `demeDataIdx` is the index of the deme in `demeData` where this will be inserted */
      deme.arcs = createOrUpdateArcs(visibleNodes, props.legendValues, props.colorBy, props.nodeColors);
      /* create back links between the arcs & which index of `demeData` they (will be) stored at */
      deme.arcs.forEach((a) => {a.demeDataIdx = index;});
    } else {
      /* average out the constituent colours for a blended-colour circle */
      deme.color = getAverageColorFromNodes(visibleNodes, props.nodeColors);
    }
    demeData.push(deme);
    demeIndices[location] = [index];
  });

  const {transmissionData, transmissionIndices} = setUpTransmissions(
    props.showTransmissionLines,
    props.nodes,
    props.visibility,
    props.geoResolution,
    demeData,
    demeIndices,
    props.nodeColors
  );

  return {demeData, demeIndices, transmissionData, transmissionIndices};
}


function renderDemes({svgDomRef, demeData, transmissionData, nodes, dateMinNumeric, dateMaxNumeric, pieChart, geoResolution, dispatch}) {
  const svg = select(svgDomRef);
  svg.selectAll("*").remove();
  const g = svg.append("g").attr("id", "StateDemes");

  drawDemesAndTransmissions(
    demeData,
    transmissionData,
    g,
    null, // not used in fn!
    nodes,
    dateMinNumeric,
    dateMaxNumeric,
    pieChart,
    geoResolution,
    dispatch
  );

  // draw text labels over each deme
  g.selectAll("demeLabels")
    .data(demeData)
    .enter()
    .append("text")
    .attr("x", (d) => d.coords.x + 10)
    .attr("y", (d) => d.coords.y)
    .text((d) => d.name)
    .attr("class", "tipLabel")
    .style("font-size", "12px");
}


function setUpTransmissions(showTransmissionLines, nodes, visibility, geoResolution, demeData, demeIndices, nodeColors) {
  /* similar to the <Map>'s setupTransmissionData */
  const transmissionData = []; /* edges, animation paths */
  const transmissionIndices = {}; /* map of transmission id to array of indices. Only used for updating? */
  const demeToDemeCounts = {}; /* Used to ompute the "extend" so that curves don't sit on top of each other */

  if (!showTransmissionLines) return {transmissionData, transmissionIndices};

  /* loop through nodes and compare each with its own children to get A->B transmissions */
  nodes.forEach((n) => {
    const nodeDeme = getTraitFromNode(n, geoResolution);
    if (n.children) {
      n.children.forEach((child) => {
        const childDeme = getTraitFromNode(child, geoResolution);
        if (nodeDeme && childDeme && nodeDeme !== childDeme) {

          // Keep track of how many we've seen from A->B in order to get a curve's "extend"
          if ([nodeDeme, childDeme] in demeToDemeCounts) {
            demeToDemeCounts[[nodeDeme, childDeme]] += 1;
          } else {
            demeToDemeCounts[[nodeDeme, childDeme]] = 1;
          }
          const extend = demeToDemeCounts[[nodeDeme, childDeme]];

          // compute a bezier curve
          // logic following the <Map>'s maybeConstructTransmissionEvent
          // console.log(`TRANSMISSION! ${nodeDeme} -> ${childDeme}, ${extend}`);
          const nodeCoords = demeData[demeIndices[nodeDeme]].coords;
          const childCoords = demeData[demeIndices[childDeme]].coords;
          const bezierCurve = bezier(nodeCoords, childCoords, extend);
          /* set up interpolator with origin and destination numdates */
          const nodeDate = getTraitFromNode(n, "num_date");
          const childDate = getTraitFromNode(child, "num_date");
          const interpolator = interpolateNumber(nodeDate, childDate);
          /* make a bezierDates array as long as bezierCurve */
          const bezierDates = bezierCurve.map((d, i) => {
            return interpolator(i / (bezierCurve.length - 1));
          });

          // following data structure same as in <Map>
          const transmission = {
            id: n.arrayIdx.toString() + "-" + child.arrayIdx.toString(),
            originNode: n,
            destinationNode: child,
            bezierCurve,
            bezierDates,
            originName: nodeDeme,
            destinationName: childDeme,
            originCoords: nodeCoords, // after interchange
            destinationCoords: childCoords, // after interchange
            originNumDate: nodeDate,
            destinationNumDate: childDate,
            color: nodeColors[n.arrayIdx], // colour given by *origin* node
            visible: visibility[child.arrayIdx] !== NODE_NOT_VISIBLE ? "visible" : "hidden", // transmission visible if child is visible
            extend: extend
          };
          transmissionData.push(transmission);
        }
      });
    }
  });

  transmissionData.forEach((transmission, index) => {
    if (!transmissionIndices[transmission.id]) {
      transmissionIndices[transmission.id] = [index];
    } else {
      transmissionIndices[transmission.id].push(index);
    }
  });

  return {transmissionData, transmissionIndices};
}

function coordFactory(width, height, n) {
  const x0 = width/2;
  const y0 = height/2;
  const t = 2 * Math.PI / (n+1);
  const r = Math.min(width, height) * 0.40;
  return (index) => {
    return {
      x: x0+r*Math.cos(t*index),
      y: y0+r*Math.sin(t*index)
    };
  };
}


const WithTranslation = withTranslation()(States);
export default WithTranslation;

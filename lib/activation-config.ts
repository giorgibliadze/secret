import "server-only";
import type { ParticipantName } from "./participants";

// Trusted hashes of the organizer-issued activation links; never accept a bootstrap token from the client.
// Raw activation tokens, passwords, and draw results are not stored in source.
export const INITIAL_ACTIVATION_HASHES: Partial<Record<ParticipantName, string>> = {
  "გიორგი": "f26aa409d40954ce2480f941c24b23efd2ca40330a28d5bddfbda1fd3af90a65",
  "ნინი": "c323a91a8361ee8a1a78d6b2e57c948f358d0da74cfbf607f06448ebc23412af",
  "მარი": "4c62be81447b94d067d3c1147bb2b79627b6d57da178edab666276260f5b4e75",
  "ანა": "60dec8c32181508098bf613ce396cdee031a802f6a386fea851cf4c219565c0f",
  "რეზი": "d8a607904bfcea758a3421635ebf284ca207649625d4d6d65609119aaa17b5ac",
  "სოსო": "2b3bc4e3027fdfabb5a60871206108548cbc6393f0dcea55e72bc5f64cce4661"
};

"use client";

import { addCollection, Icon } from "@iconify/react/offline";
import { weatherCodeToIcon } from "@openmapx/core";
import weatherMeteocons from "./meteocons.json";

addCollection(weatherMeteocons);

interface Props {
  code: number;
  isDay: boolean;
  size?: number;
}

export function WeatherIcon({ code, isDay, size = 24 }: Props) {
  const iconName = weatherCodeToIcon(code, isDay);

  return <Icon icon={`meteocons:${iconName}`} width={size} height={size} aria-hidden="true" />;
}

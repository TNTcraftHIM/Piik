import { createContext } from "react";
import { designPeople } from "./fixtures";

export const DesignNames = createContext<(index: number) => string>(index => designPeople[index].name);

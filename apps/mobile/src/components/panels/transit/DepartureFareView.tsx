import { MaterialIcons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

interface FareProduct {
  name: string;
  amount: number;
  currency: string;
}

interface DepartureFareViewProps {
  products: FareProduct[];
}

function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function DepartureFareView({ products }: DepartureFareViewProps) {
  const { t } = useTranslation();
  if (products.length === 0) return null;

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <MaterialIcons name="confirmation-number" size={18} color="#888" />
        <Text style={styles.headerText}>{t("directions.fare")}</Text>
      </View>
      {products.map((product) => (
        <View key={product.name} style={styles.productRow}>
          <Text style={styles.productName}>{product.name}</Text>
          <Text style={styles.productAmount}>
            {formatCurrency(product.amount, product.currency)}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e0e0e0",
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  headerText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#333",
  },
  productRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 2,
  },
  productName: {
    fontSize: 12,
    color: "#888",
  },
  productAmount: {
    fontSize: 12,
    color: "#888",
  },
});
